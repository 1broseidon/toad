import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	DefaultResourceLoader,
	SessionManager,
	createAgentSession,
	type AgentSession,
	type AgentSessionEvent,
	type ModelRuntime,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { ImageContent, ThinkingLevel } from "@earendil-works/pi-ai";
import type {
	Attachment,
	Persona,
	SessionInfo,
	TranscriptEvent,
} from "../../shared/types";
import { resolveSubagentRoster } from "../../shared/subagents";
import { conversationHandoffBlock, houseStyleBlock } from "../acp/style";
import type { Emitters, SessionOptions, TeammateSession } from "../agent/session";
import { idleInfo } from "../agent/session";
import { PI_DIR } from "../paths";
import { BUILT_IN_AGENT_NAME } from "../acp/registry";
import {
	bridgeAttachmentEnabled,
	registerBridgeScope,
	revokeBridgeScope,
} from "../mcp/bridge";
import { warmComputer } from "../computer/manager";
import { resolveMcpServers } from "../mcp/servers";
import { getSettings } from "../store/settings";
import { McpTools } from "./mcp";
import { gateParentComputer, releaseComputer } from "./computer-lease";
import { contextFilesInWorkspace, withoutHomeAgentsSkills } from "./isolation";
import { THINKING_MODES, availableModels, modelChoiceId, piRuntime } from "./runtime";
import { NO_BASH_NOTICE, builtInTools, missingBashOnWindows } from "./shell";
import { armToadTools, toadTools } from "./toad-tools";
import { MAX_LIVE_SUBAGENTS, subagentTool, type SubagentHost } from "./subagent";
import { describeTool, locationsOf, outputOf } from "./tools";
import { webSearchToolForPersona } from "./web-search";

const now = () => Date.now();

function short(err: unknown): string {
	const message = err instanceof Error ? err.message : String(err);
	return message.length > 200 ? `${message.slice(0, 200)}…` : message;
}

type EndedMessage = {
	role?: string;
	stopReason?: string;
	errorMessage?: string;
	usage?: { input?: number; output?: number; totalTokens?: number };
};

function stopReasonOf(messages: readonly EndedMessage[], willRetry: boolean): string {
	if (willRetry) return "retrying";
	return messages[messages.length - 1]?.stopReason ?? "end_turn";
}

/** What the whole run cost, which is what the transcript's turn line reports. */
function usageOf(messages: readonly EndedMessage[]) {
	let inputTokens = 0;
	let outputTokens = 0;
	let totalTokens = 0;
	for (const message of messages) {
		inputTokens += message.usage?.input ?? 0;
		outputTokens += message.usage?.output ?? 0;
		totalTokens += message.usage?.totalTokens ?? 0;
	}
	return totalTokens > 0 ? { inputTokens, outputTokens, totalTokens } : undefined;
}

/**
 * One live conversation with pi, in this process, on behalf of one persona.
 *
 * The counterpart to `AcpSession`, and deliberately much smaller: there is no
 * child process, no JSON-RPC, no capability negotiation and no protocol
 * translation — pi's events are already the shape Toad wants, so most of this
 * file is naming things rather than plumbing them.
 *
 * The things ACP made hard are the things that disappear here. Identity is a
 * system prompt instead of a file written into the user's repository. Restoring
 * a conversation is opening a session file instead of hoping the backend still
 * recognises an opaque id. Teammate tools are functions instead of a socket.
 */
export class PiSession implements TeammateSession {
	private session?: AgentSession;
	private runtime?: ModelRuntime;
	private mcp?: McpTools;
	private unsubscribe?: () => void;
	private info: SessionInfo;
	private readonly bridgeToken = randomBytes(32).toString("hex");

	/** Buffers streaming chunks so the transcript stores whole messages. */
	private openMessage: { eventId: string; kind: "agent" | "thought"; text: string } | null = null;

	/** The last state written for each live tool call, to merge updates into. */
	private toolCalls = new Map<string, Extract<TranscriptEvent, { kind: "tool" }>>();

	/** True once this session's file is safe to reopen. */
	private checkpointed = false;

	/** Nested subagents started by `subagent`. Their events never reach `emit`. */
	private subagents = new Set<AgentSession>();
	private liveSubagents = 0;
	/** Abort controllers for background jobs; a finished parent turn must not kill them. */
	private jobAborts = new Set<AbortController>();
	/** One configured instance is shared with this teammate's subagents, including its cache. */
	private webSearchTools: ToolDefinition[] = [];

	constructor(
		private persona: Persona,
		private emit: Emitters,
		private options?: SessionOptions,
	) {
		this.info = idleInfo(persona.id);
	}

	getInfo(): SessionInfo {
		return this.info;
	}

	private patchInfo(patch: Partial<SessionInfo>): void {
		this.info = { ...this.info, ...patch };
		this.emit.infoChanged(this.info);
	}

	private notice(level: "info" | "warn" | "error", text: string): void {
		this.emit.appendEvent({
			kind: "notice",
			id: randomUUID(),
			ts: now(),
			level,
			text: text.replaceAll(this.bridgeToken, "[redacted]"),
		});
	}

	// -- lifecycle ----------------------------------------------------------

	/**
	 * Everything Toad wants the agent to know before anyone speaks.
	 *
	 * ACP has no system-prompt parameter, which is why a persona's identity has
	 * to be written to disk as AGENTS.md and why the house style has to ride
	 * along with the first message. Here all three — who you are, what room you
	 * are in, and what was said before you existed — are simply the system
	 * prompt, which is what they always were.
	 */
	private systemPrompt(restored: boolean): string {
		const parts = [
			this.options?.briefing?.().text ??
				houseStyleBlock({
					teammateTools: Boolean(bridgeAttachmentEnabled()),
					subagentTool: true,
					subagents: resolveSubagentRoster(this.persona),
				}).text,
		];

		const goal = this.persona.goal.trim();
		if (goal.length > 0) {
			parts.push(`You are ${this.persona.name}. You were created for this:\n\n${goal}`);
		}

		if (!restored) {
			const handoff = conversationHandoffBlock(this.emit.history(), {
				tools: Boolean(bridgeAttachmentEnabled()),
			});
			if (handoff) parts.push(handoff.text);
		}

		return parts.join("\n\n");
	}

	async start(): Promise<SessionInfo> {
		if (this.info.state === "ready" || this.info.state === "thinking") return this.info;
		this.patchInfo({ state: "starting", error: undefined });
		registerBridgeScope(
			this.bridgeToken,
			this.options?.scope ?? { kind: "human", personaId: this.persona.id },
		);

		try {
			mkdirSync(this.persona.cwd, { recursive: true });

			const previous = this.persona.sessionCheckpoints.find(
				(checkpoint) => checkpoint.backendId === this.persona.backendId,
			)?.sessionId;
			const restored = Boolean(previous && existsSync(previous));
			this.checkpointed = restored;

			const loader = new DefaultResourceLoader({
				cwd: this.persona.cwd,
				agentDir: PI_DIR,
				systemPromptOverride: () => this.systemPrompt(restored),
				skillsOverride: ({ skills, diagnostics }) => ({
					skills: withoutHomeAgentsSkills(skills),
					diagnostics,
				}),
				agentsFilesOverride: ({ agentsFiles }) => ({
					agentsFiles: contextFilesInWorkspace(agentsFiles, this.persona.cwd, PI_DIR),
				}),
			});
			await loader.reload();

			const modelRuntime = await piRuntime();
			this.runtime = modelRuntime;

			/* Connected before the session is built, because the tool list is fixed
			 * at creation: a server that arrives late would be invisible until the
			 * teammate is restarted, which is worse than waiting for it.
			 * The computer's handshake does not wake the machine; start the pull
			 * now so the first tool call is not the thing that waits on GHCR. */
			if (this.persona.computer?.enabled) {
				warmComputer({
					personaId: this.persona.id,
					cwd: this.persona.cwd,
					image: this.persona.computer.image,
					notice: (level, text) => this.notice(level, text),
				});
			}
			const servers = resolveMcpServers(this.persona);
			this.mcp =
				servers.length > 0
					? await McpTools.connect(servers, (level, text) => this.notice(level, text))
					: undefined;
			const mcpTools = this.mcp?.tools() ?? [];
			const webSearch = webSearchToolForPersona(this.persona, getSettings());
			this.webSearchTools = webSearch ? [webSearch] : [];
			const customTools = [
				...toadTools(this.bridgeToken),
				/* The teammate's own computer calls check the lease: while a
				 * subagent holds the desktop, the parent gets a "hands busy"
				 * result instead of silently blocking mid-conversation. Subagents
				 * receive the raw tools (via subagentContext) and get their own
				 * waiting gate. */
				...gateParentComputer(this.persona.id, mcpTools),
				...this.webSearchTools,
				subagentTool(
					{
						context: () => this.subagentContext(),
						begin: () => this.beginSubagent(),
						end: () => this.endSubagent(),
						track: (nested) => this.subagents.add(nested),
						untrack: (nested) => this.subagents.delete(nested),
						notify: (text) => {
							if (!this.session) return;
							this.nudge(text);
						},
						jobSignal: () => this.startJobSignal(),
					},
					resolveSubagentRoster(this.persona),
				),
			];

			const { session, modelFallbackMessage } = await createAgentSession({
				cwd: this.persona.cwd,
				agentDir: PI_DIR,
				modelRuntime,
				resourceLoader: loader,
				model: this.persona.modelId ? this.model(this.persona.modelId) : undefined,
				thinkingLevel: (this.persona.modeId as ThinkingLevel | undefined) ?? "off",
				/* Undefined everywhere but Windows, which is the only platform where
				 * pi's default shell tool may name a binary the machine does not
				 * have. See `./shell` for why PowerShell complements bash there
				 * rather than replacing it.
				 *
				 * The custom tools are named alongside them because pi reads this
				 * list twice: once as the built-ins to start active, and once as an
				 * allowlist it also applies to custom tools. Naming only the five
				 * built-ins therefore deleted every tool Toad supplies — all the
				 * bridge tools, subagents, the computer, web search — on Windows
				 * alone, silently, while the system prompt still promised them.
				 * That is how a teammate hopped to the Windows desk and found it
				 * had no way to hop home. */
				tools: builtInTools(customTools.map((tool) => tool.name)),
				customTools,
				sessionManager: restored
					? SessionManager.open(previous!, join(PI_DIR, "sessions"))
					: SessionManager.create(this.persona.cwd, join(PI_DIR, "sessions")),
			});

			this.session = session;
			this.unsubscribe = session.subscribe((event) => this.handle(event));

			this.patchInfo({
				state: "ready",
				sessionId: session.sessionFile,
				agentName: BUILT_IN_AGENT_NAME,
				contextRestored: restored,
				models: await availableModels(),
				currentModelId: session.model ? modelChoiceId(session.model) : undefined,
				modes: THINKING_MODES,
				currentModeId: session.thinkingLevel,
				capabilities: {
					loadSession: true,
					resume: true,
					fork: true,
					mcpHttp: false,
					image: (session.model?.input ?? []).includes("image"),
				},
			});

			if (modelFallbackMessage) this.notice("info", modelFallbackMessage);
			/* Said at startup, to the user, once — rather than leaving pi's own
			 * "no bash shell found" paragraph to surface as the result of the
			 * teammate's first command, where only the model would read it. */
			if (missingBashOnWindows()) this.notice("info", NO_BASH_NOTICE);
			if (mcpTools.length > 0) {
				this.notice(
					"info",
					`${mcpTools.length} tool${mcpTools.length === 1 ? "" : "s"} from ${(this.mcp?.summary() ?? []).join(", ")}.`,
				);
			}
			if (!session.model) {
				this.patchInfo({
					state: "error",
					error: "No model is set up yet. Add a provider key in Settings.",
				});
			}
		} catch (err) {
			this.patchInfo({ state: "error", error: short(err) });
		}

		return this.info;
	}

	async stop(): Promise<void> {
		revokeBridgeScope(this.bridgeToken);
		this.flushMessage();
		this.unsubscribe?.();
		this.unsubscribe = undefined;
		try {
			await this.session?.abort();
		} catch {
			/* nothing was running */
		}
		this.abortJobs();
		await this.abortSubagents();
		// Aborted subagents release their own holds; this clears the parent's.
		releaseComputer(this.persona.id, { kind: "parent" });
		this.session?.dispose();
		this.session = undefined;
		await this.mcp?.close();
		this.mcp = undefined;
		this.patchInfo({ state: "stopped" });
	}

	// -- turns --------------------------------------------------------------

	/**
	 * Runs one turn immediately and resolves once it ends — the peer path,
	 * which drives its own turn-taking and needs to await completion.
	 */
	async prompt(text: string, attachments: Attachment[] = [], shown = text): Promise<void> {
		const session = this.require();
		this.record(shown, attachments);
		await this.dispatch(session, text, attachments, "followUp");
	}

	/**
	 * A message sent the ordinary way. Written to the transcript at once, then
	 * handed to pi, which delivers it when the running turn is done.
	 */
	send(text: string, attachments: Attachment[] = [], shown = text): void {
		const session = this.require();
		this.record(shown, attachments);
		void this.dispatch(session, this.withPaths(text, attachments), attachments, "followUp").catch(
			(err) => this.notice("error", `Turn failed: ${short(err)}`),
		);
	}

	/**
	 * A message sent to redirect rather than to follow up.
	 *
	 * pi delivers this after the running turn's tool calls finish and before the
	 * next model call, rather than cancelling outright the way the ACP path has
	 * to. Nothing already generated is thrown away, which is both cheaper and
	 * closer to what interrupting a colleague actually looks like — they finish
	 * the sentence they were typing, then read you. The hard stop is still
	 * available; it is `cancel`, and it has its own button.
	 */
	steer(text: string, attachments: Attachment[] = [], shown = text): void {
		const session = this.require();
		this.record(shown, attachments);
		void this.dispatch(session, this.withPaths(text, attachments), attachments, "steer").catch(
			(err) => this.notice("error", `Turn failed: ${short(err)}`),
		);
	}

	/** Toad's own words to the agent: a turn, but not a line of the conversation. */
	nudge(text: string): void {
		const session = this.require();
		void this.dispatch(session, text, [], "followUp").catch((err) =>
			this.notice("error", `Turn failed: ${short(err)}`),
		);
	}

	/**
	 * Sends, and takes responsibility for the busy state around it.
	 *
	 * `thinking` is set here rather than when pi reports `agent_start`, because
	 * the two are not the same moment: pi starts asynchronously, and anything
	 * that looks at the session between the send and that first event — the
	 * composer deciding whether the next message is a steer, a caller waiting
	 * for the turn to finish — would see an idle teammate and act on it. The ACP
	 * path makes the same guarantee by setting the state before it awaits.
	 */
	private async dispatch(
		session: AgentSession,
		text: string,
		attachments: Attachment[],
		streamingBehavior: "steer" | "followUp",
	): Promise<void> {
		this.patchInfo({ state: "thinking" });
		try {
			await session.prompt(text, { images: this.images(attachments), streamingBehavior });
		} catch (err) {
			// A rejected send never runs, so no settle event is coming to undo this.
			if (this.info.state === "thinking") this.patchInfo({ state: "ready" });
			throw err;
		}
	}

	async cancel(): Promise<void> {
		// Cancel the live chat turn only. Background jobs — subagents sent
		// off to work alongside it — keep running until this session stops.
		await this.session?.abort();
	}

	private subagentContext(): SubagentHost | undefined {
		if (!this.runtime || !this.session) return undefined;
		return {
			cwd: this.persona.cwd,
			personaId: this.persona.id,
			teammateName: this.persona.name,
			goal: this.persona.goal,
			model: this.session.model,
			thinkingLevel: this.session.thinkingLevel,
			runtime: this.runtime,
			extraTools: [...(this.mcp?.tools() ?? []), ...this.webSearchTools],
			armTools: armToadTools(this.bridgeToken),
			roster: resolveSubagentRoster(this.persona),
		};
	}

	private beginSubagent(): "ok" | "busy" {
		if (this.liveSubagents >= MAX_LIVE_SUBAGENTS) return "busy";
		this.liveSubagents += 1;
		return "ok";
	}

	private endSubagent(): void {
		this.liveSubagents = Math.max(0, this.liveSubagents - 1);
	}

	private startJobSignal(): { signal: AbortSignal; done: () => void } {
		const ac = new AbortController();
		this.jobAborts.add(ac);
		return {
			signal: ac.signal,
			done: () => this.jobAborts.delete(ac),
		};
	}

	private abortJobs(): void {
		for (const ac of this.jobAborts) ac.abort();
		this.jobAborts.clear();
	}

	private async abortSubagents(): Promise<void> {
		const live = [...this.subagents];
		await Promise.all(
			live.map(async (nested) => {
				try {
					await nested.abort();
				} catch {
					/* already idle */
				}
			}),
		);
	}

	private require(): AgentSession {
		if (!this.session) throw new Error("Session is not ready");
		return this.session;
	}

	/** Writes the user's turn to the transcript immediately. */
	private record(text: string, attachments: Attachment[]): void {
		this.emit.appendEvent({
			kind: "user",
			id: randomUUID(),
			ts: now(),
			text,
			...(attachments.length > 0 ? { attachments } : {}),
		});
	}

	/**
	 * Images the model can actually take, inlined; anything else is left to
	 * `withPaths`. A model without image input gets nothing here, because the
	 * bytes would be wasted and some providers reject the block outright.
	 */
	private images(attachments: Attachment[]): ImageContent[] {
		if (!this.info.capabilities.image) return [];
		const images: ImageContent[] = [];
		for (const item of attachments) {
			if (item.kind !== "image" || !item.mimeType) continue;
			try {
				images.push({
					type: "image",
					mimeType: item.mimeType,
					data: readFileSync(item.path).toString("base64"),
				});
			} catch (err) {
				this.notice("warn", `Could not read ${item.name}: ${short(err)}`);
			}
		}
		return images;
	}

	/**
	 * Names non-image attachments by path.
	 *
	 * A coding agent already has the filesystem and its own `read` tool, so a
	 * path is a better attachment than its contents: it costs nothing to send
	 * and the agent decides whether it needs to open it.
	 */
	private withPaths(text: string, attachments: Attachment[]): string {
		const linked = attachments.filter(
			(item) => !(item.kind === "image" && this.info.capabilities.image),
		);
		if (linked.length === 0) return text;
		const list = linked.map((item) => `- ${item.name}: ${item.path}`).join("\n");
		return `${text}\n\nAttached:\n${list}`;
	}

	// -- disposition --------------------------------------------------------

	private model(choiceId: string) {
		const slash = choiceId.indexOf("/");
		if (slash === -1) return undefined;
		return (
			this.runtime?.getModel(choiceId.slice(0, slash), choiceId.slice(slash + 1)) ?? undefined
		);
	}

	async setModel(modelId: string): Promise<SessionInfo> {
		const session = this.require();
		const model = this.model(modelId);
		if (!model) throw new Error(`Unknown model ${modelId}`);
		await session.setModel(model);
		this.patchInfo({
			currentModelId: modelId,
			capabilities: { ...this.info.capabilities, image: model.input.includes("image") },
		});
		return this.info;
	}

	async setMode(modeId: string): Promise<SessionInfo> {
		this.require().setThinkingLevel(modeId as ThinkingLevel);
		this.patchInfo({ currentModeId: modeId });
		return this.info;
	}

	async setConfig(_configId: string, _value: string): Promise<SessionInfo> {
		throw new Error("This agent has no configuration options");
	}

	/**
	 * Nothing asks for permission yet: pi runs its tools, which is the point of
	 * choosing it. The gate is a `tool_call` interceptor and it is filed, not
	 * built — this exists so the shape is already right when it lands.
	 */
	answerPermission(_requestId: string, _optionId: string): boolean {
		return false;
	}

	updatePersona(persona: Persona): void {
		this.persona = persona;
	}

	// -- event translation --------------------------------------------------

	private handle(event: AgentSessionEvent): void {
		switch (event.type) {
			case "agent_start":
				this.patchInfo({ state: "thinking" });
				return;

			case "message_update": {
				const inner = event.assistantMessageEvent;
				if (inner.type === "text_delta") this.appendChunk("agent", inner.delta);
				if (inner.type === "thinking_delta") this.appendChunk("thought", inner.delta);
				return;
			}

			case "tool_execution_start": {
				this.flushMessage();
				const entry: Extract<TranscriptEvent, { kind: "tool" }> = {
					kind: "tool",
					id: `tool:${event.toolCallId}`,
					ts: now(),
					toolCallId: event.toolCallId,
					title: describeTool(event.toolName, event.args),
					toolKind: event.toolName,
					status: "in_progress",
					locations: locationsOf(this.persona.cwd, event.args),
				};
				this.toolCalls.set(event.toolCallId, entry);
				this.emit.appendEvent(entry);
				return;
			}

			case "tool_execution_end": {
				const previous = this.toolCalls.get(event.toolCallId);
				const entry: Extract<TranscriptEvent, { kind: "tool" }> = {
					kind: "tool",
					id: `tool:${event.toolCallId}`,
					ts: previous?.ts ?? now(),
					toolCallId: event.toolCallId,
					title: previous?.title ?? describeTool(event.toolName, {}),
					toolKind: event.toolName,
					status: event.isError ? "failed" : "completed",
					locations: previous?.locations,
					output: outputOf(event.result),
				};
				this.toolCalls.set(event.toolCallId, entry);
				this.emit.updateEvent(entry);
				return;
			}

			case "agent_end": {
				this.flushMessage();
				this.settleInterruptedTools();
				this.reportFailure(event.messages);
				this.emit.appendEvent({
					kind: "turn",
					id: randomUUID(),
					ts: now(),
					stopReason: stopReasonOf(event.messages, event.willRetry),
					usage: usageOf(event.messages),
				});
				this.checkpoint();
				return;
			}

			/* Settling, not ending, is what returns a teammate to idle: a queued
			 * follow-up starts another run straight after `agent_end`, and reporting
			 * ready in between would flicker the composer through a state the
			 * conversation was never actually in. */
			case "agent_settled":
				// The turn is the parent's natural hold: hands off the computer
				// between turns, so a waiting subagent gets its go.
				releaseComputer(this.persona.id, { kind: "parent" });
				this.patchInfo({ state: "ready" });
				return;

			default:
				return;
		}
	}

	/**
	 * Says so when a turn ended badly.
	 *
	 * pi does not throw for a failed model call — the run completes and the
	 * failure is a `stopReason` on the last assistant message. Nothing else in
	 * Toad reads that, so without this a turn that never happened is
	 * indistinguishable from a turn the agent chose not to answer: the composer
	 * returns to ready, the transcript shows the question and nothing after it.
	 * That is the worst failure a chat app can have, and it is the quiet one.
	 */
	private reportFailure(messages: readonly EndedMessage[]): void {
		const last = messages[messages.length - 1];
		if (!last || (last.stopReason !== "error" && last.stopReason !== "aborted")) return;
		if (last.stopReason === "aborted") return; // Cancelling is a choice, not a fault.
		this.notice("error", `Turn failed: ${short(last.errorMessage ?? "the model returned an error")}`);
	}

	/**
	 * Records the session file once a turn has completed.
	 *
	 * Deferred past session creation for the same reason the ACP path defers it:
	 * a checkpoint is a promise that reopening will restore something, and an
	 * empty session is not worth making that promise about.
	 */
	private checkpoint(): void {
		if (this.checkpointed) return;
		const file = this.session?.sessionFile;
		if (!file) return;
		try {
			this.emit.sessionCheckpointed(this.persona.backendId, file);
			this.checkpointed = true;
		} catch (err) {
			this.notice("error", `Could not save session continuity: ${short(err)}`);
		}
	}

	private settleInterruptedTools(): void {
		for (const [id, call] of this.toolCalls) {
			if (call.status !== "pending" && call.status !== "in_progress") continue;
			const settled = { ...call, status: "failed" as const };
			this.toolCalls.set(id, settled);
			this.emit.updateEvent(settled);
		}
	}

	private appendChunk(kind: "agent" | "thought", delta: string): void {
		if (!delta) return;
		if (!this.openMessage || this.openMessage.kind !== kind) {
			this.flushMessage();
			this.openMessage = { eventId: randomUUID(), kind, text: "" };
		}
		this.openMessage.text += delta;
		this.emit.delta(this.openMessage.eventId, kind, delta);
	}

	/** Writes the buffered streaming message to the transcript as one event. */
	private flushMessage(): void {
		const open = this.openMessage;
		this.openMessage = null;
		if (!open || open.text.length === 0) return;
		this.emit.appendEvent({
			kind: open.kind === "agent" ? "agent" : "thought",
			id: open.eventId,
			ts: now(),
			text: open.text,
		});
	}
}
