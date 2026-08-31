import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { client, ndJsonStream, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import type { ClientContext } from "@agentclientprotocol/sdk";
import type {
	Attachment,
	ConfigChoice,
	McpRuntimeServerConfig,
	Persona,
	SessionInfo,
	SlashCommand,
	ToolOutput,
	ToolStatus,
	TranscriptEvent,
} from "../../shared/types";
import { idleInfo } from "../agent/session";
import type { Emitters, SessionOptions, TeammateSession } from "../agent/session";
import { ToolLedger } from "../agent/tool-ledger";
import { childEnv } from "../child-env";
import { resolveLaunch } from "./registry";
import { conversationHandoffBlock, houseStyleBlock } from "./style";
import { sidecarVerdict } from "../mcp/compat";
import { sidecarDescriptor } from "../mcp/descriptor";
import { bridgeAttachmentEnabled, registerBridgeScope, revokeBridgeScope } from "../mcp/bridge";
import { TOAD_TOOLS } from "../mcp/tools";
import { warmComputer } from "../computer/manager";
import { missingPolicyServers, resolveMcpServers } from "../mcp/servers";
import { isPluginServerId, pluginToolRows } from "../plugin/descriptor";
import {
	dispositionOf,
	type SessionConfigOption,
	type SessionDisposition,
} from "./config-options";

type Deferred<T> = { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void };

type PermissionSettlement =
	| { decision: "selected"; optionId: string }
	| { decision: "cancelled" | "expired" };

type PendingPermission = {
	deferred: Deferred<PermissionSettlement>;
	event: Extract<TranscriptEvent, { kind: "permission" }>;
	timer: ReturnType<typeof setTimeout>;
};

/** Live ACP permission requests cannot wait on an absent human forever. */
export const ACP_PERMISSION_TIMEOUT_MS = 10 * 60_000;

/** One message waiting to become a `session/prompt` call. */
type QueueItem = { text: string; attachments: Attachment[] };

/** The partial tool call attached to a session/request_permission. */
type PermissionToolCall = {
	toolCallId?: string;
	title?: string;
	kind?: string;
	rawInput?: { command?: unknown };
};

/** Plain-language stand-ins for ACP tool kinds, for when nothing better came. */
const PERMISSION_VERBS: Record<string, string> = {
	edit: "edit files",
	execute: "run a command",
	read: "read files",
	delete: "delete files",
	move: "move files",
	fetch: "fetch from the network",
	search: "search the workspace",
};

function deferred<T>(): Deferred<T> {
	let resolve!: (v: T) => void;
	let reject!: (e: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

const now = () => Date.now();

/**
 * One live ACP conversation with one backend process, on behalf of one persona.
 *
 * Owns the child process, the JSON-RPC connection, and the translation from
 * ACP's typed update stream into Toad's transcript events.
 */
export class AcpSession implements TeammateSession {
	private proc?: Bun.Subprocess;
	private ctx?: ClientContext;
	private shutdown = deferred<void>();
	private connectionDone?: Promise<unknown>;

	private info: SessionInfo;
	private pendingPermissions = new Map<string, PendingPermission>();

	/** Buffers streaming chunks so the transcript stores whole messages. */
	private openMessage: { eventId: string; kind: "agent" | "thought"; text: string } | null = null;

	/**
	 * The last state written for each live tool call. A tool_call_update carries
	 * only what changed, so without somewhere to merge into, a status change
	 * arrives as a payload of blanks and erases the title.
	 */
	private toolCalls = new Map<string, Extract<TranscriptEvent, { kind: "tool" }>>();

	/** session/load replays the whole history; suppress writes while it does. */
	private replaying = false;

	/**
	 * Whether this connection has been told what kind of room it is speaking in.
	 * Scoped to the process, so a restarted backend hears it again and a resumed
	 * one does not hear it twice in the same conversation.
	 */
	private briefed = false;

	/** True once this backend's current session id is safe to open again. */
	private checkpointed = false;

	private stderrTail: string[] = [];
	private readonly bridgeToken = randomBytes(32).toString("hex");
	private compatNoticeEmitted = false;
	private oauthNoticeEmitted = false;
	private sidecarAttached = false;
	private modelConfigId?: string;
	private modeConfigId?: string;

	/**
	 * Messages sent while a turn is running.
	 *
	 * `queue` holds ordinary follow-ups: everything in it is batched into one
	 * next turn once the current one ends on its own. `priority` holds a
	 * steer — sent alone, ahead of the queue, the moment the live turn is
	 * cancelled. A second steer simply replaces the first; there is only ever
	 * one "no, stop, this instead" in flight.
	 */
	private queue: QueueItem[] = [];
	private priority: QueueItem | null = null;

	/** Whether the handoff has already been captured for this connection. */
	private handoffCaptured = false;
	/**
	 * History from before the very first thing said on this connection,
	 * captured at that moment so a message queued behind it cannot end up
	 * quoted in its own handoff.
	 */
	private pendingHandoff?: { type: "text"; text: string };

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

	async start(): Promise<SessionInfo> {
		if (this.info.state === "ready" || this.info.state === "thinking") return this.info;
		this.patchInfo({ state: "starting", error: undefined });
		registerBridgeScope(
			this.bridgeToken,
			this.options?.scope ?? { kind: "human", personaId: this.persona.id },
		);

		let launch: { cmd: string; args: string[]; env?: Record<string, string> };
		try {
			launch = await resolveLaunch(this.persona.backendId);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			this.patchInfo({ state: "error", error: message });
			return this.info;
		}

		mkdirSync(this.persona.cwd, { recursive: true });
		if (this.persona.computer?.enabled) {
			warmComputer({
				personaId: this.persona.id,
				cwd: this.persona.cwd,
				image: this.persona.computer.image,
				notice: (level, text) => this.notice(level, text),
			});
		}

		try {
			this.proc = Bun.spawn([launch.cmd, ...launch.args], {
				cwd: this.persona.cwd,
				stdin: "pipe",
				stdout: "pipe",
				stderr: "pipe",
				// Some agents need a variable set to behave: two of them use one to
				// stop auto-updating themselves out from under a running session.
				// childEnv drops Electrobun/Bun leftovers that abort Node (Claude).
				// MCP_TOOL_TIMEOUT (claude's MCP client; harmless elsewhere) is
				// leftover margin for a long MCP tool — teammate jobs no longer
				// hold the sidecar for minutes.
				env: childEnv({ MCP_TOOL_TIMEOUT: "660000", ...launch.env }),
			});
		} catch (err) {
			const message = `Could not start ${launch.cmd}: ${err instanceof Error ? err.message : String(err)}`;
			this.patchInfo({ state: "error", error: message });
			return this.info;
		}

		this.pumpStderr();
		this.watchExit();

		const ready = deferred<void>();
		this.connectionDone = this.runConnection(ready).catch((err) => {
			const message = err instanceof Error ? err.message : String(err);
			if (this.info.state !== "stopped") {
				this.patchInfo({ state: "error", error: message });
			}
			ready.resolve();
		});

		await ready.promise;

		return this.info;
	}

	private async runConnection(ready: Deferred<void>): Promise<void> {
		const proc = this.proc!;
		const stdout = proc.stdout as ReadableStream<Uint8Array>;
		const sink = proc.stdin as import("bun").FileSink;

		const stdin = new WritableStream<Uint8Array>({
			write: (chunk) => {
				sink.write(chunk);
				sink.flush();
			},
			close: () => {
				try {
					sink.end();
				} catch {
					/* already closed */
				}
			},
		});

		const app = client({ name: "Toad" })
			.onNotification("session/update", ({ params }) => {
				this.handleUpdate(params as unknown as Record<string, unknown>);
			})
			.onRequest("session/request_permission", async ({ params }) => {
				return this.handlePermission(params as unknown as Record<string, unknown>);
			})
			.onRequest("fs/read_text_file", async ({ params }) => {
				const text = await Bun.file(params.path).text();
				if (params.line == null && params.limit == null) return { content: text };
				const lines = text.split("\n");
				const from = Math.max(0, (params.line ?? 1) - 1);
				const slice =
					params.limit == null ? lines.slice(from) : lines.slice(from, from + params.limit);
				return { content: slice.join("\n") };
			})
			.onRequest("fs/write_text_file", async ({ params }) => {
				await Bun.write(params.path, params.content);
				return {};
			});

		await app.connectWith(ndJsonStream(stdin, stdout), async (ctx) => {
			this.ctx = ctx;

			const init = (await ctx.request("initialize", {
				protocolVersion: PROTOCOL_VERSION,
				clientCapabilities: {
					fs: { readTextFile: true, writeTextFile: true },
					terminal: false,
				},
			})) as InitializeResult;

			const caps = init.agentCapabilities ?? {};
			this.patchInfo({
				agentName: init.agentInfo?.name,
				agentVersion: init.agentInfo?.version,
				capabilities: {
					loadSession: Boolean(caps.loadSession),
					resume: Boolean(caps.sessionCapabilities?.resume),
					fork: Boolean(caps.sessionCapabilities?.fork),
					mcpHttp: Boolean(caps.mcpCapabilities?.http),
					image: Boolean(caps.promptCapabilities?.image),
				},
			});

			await this.openSession(ctx);
			ready.resolve();
			await this.shutdown.promise;
		});
	}

	/**
	 * Restores the agent's own context when it can. A failed restore is an
	 * implementation detail as long as a fresh session opens: Toad can bridge
	 * that session from its transcript on the first turn.
	 */
	private async openSession(ctx: ClientContext): Promise<void> {
		const cwd = this.persona.cwd;
		const mcpServers = this.mcpServers();
		const previous = this.persona.sessionCheckpoints.find(
			(checkpoint) => checkpoint.backendId === this.persona.backendId,
		)?.sessionId;
		this.checkpointed = false;

		if (previous) {
			const { resume, loadSession } = this.info.capabilities;
			if (resume) {
				try {
					const res = (await ctx.request("session/resume", {
						sessionId: previous,
						cwd,
						mcpServers,
					} as never)) as NewSessionResult | undefined;
					this.adoptSession(previous, res);
					this.checkpointed = true;
					this.patchInfo({ state: "ready", contextRestored: true });
					return;
				} catch {
					// Some agents advertise both methods but can only resume
					// particular sessions. session/load is still a valid fallback.
				}
			}
			if (loadSession) {
				this.replaying = true;
				try {
					const res = (await ctx.request("session/load", {
						sessionId: previous,
						cwd,
						mcpServers,
					} as never)) as NewSessionResult | undefined;
					this.adoptSession(previous, res);
					this.checkpointed = true;
					this.patchInfo({ state: "ready", contextRestored: true });
					return;
				} catch {
					// A stale or backend-invalid checkpoint degrades to session/new.
				} finally {
					this.replaying = false;
				}
			}
		}

		const builder = ctx.buildSession({ cwd, mcpServers } as never);
		const active = await builder.start();
		this.adoptSession(active.sessionId, active.newSessionResponse as NewSessionResult);
		this.patchInfo({ state: "ready", contextRestored: false, restoreNote: undefined });
	}

	private adoptSession(sessionId: string, res?: NewSessionResult): void {
		this.toolCalls.clear();
		this.applyDisposition(sessionId, dispositionOf(res));

		// Re-apply the persona's disposition so a teammate keeps its identity
		// across restarts, since these are session-scoped rather than persisted
		// by the agent.
		if (this.persona.modeId && this.persona.modeId !== this.info.currentModeId) {
			void this.setMode(this.persona.modeId).catch(() => undefined);
		}
		if (this.persona.modelId && this.persona.modelId !== this.info.currentModelId) {
			void this.setModel(this.persona.modelId).catch(() => undefined);
		}
	}

	private applyDisposition(sessionId: string, disposition: SessionDisposition): void {
		this.modelConfigId = disposition.modelConfigId;
		this.modeConfigId = disposition.modeConfigId;
		this.patchInfo({
			sessionId,
			models: disposition.models,
			currentModelId: disposition.currentModelId,
			modelLabel: disposition.modelLabel,
			modes: disposition.modes,
			currentModeId: disposition.currentModeId,
			modeLabel: disposition.modeLabel,
			configs: disposition.configs,
		});
	}

	/**
	 * The MCP servers this session is opened with.
	 *
	 * The spec does not say whether an agent merges a supplied list with its own
	 * configured tools or replaces them, so Toad no longer guesses in either
	 * direction: `sidecarAttachable` is an empirical allow-list, populated by
	 * scripts/verify-mcp-sidecar.ts, of backends observed to keep their native tools
	 * when a server is supplied. A backend not on it gets nothing extra, and the
	 * teammate tools are simply absent for it.
	 */
	private mcpServers(): unknown[] {
		const resolved = resolveMcpServers(this.persona);
		const oauthCount = resolved.filter(
			(server) => server.type === "http" && server.auth.mode === "oauth",
		).length;
		if (oauthCount > 0 && !this.oauthNoticeEmitted) {
			this.oauthNoticeEmitted = true;
			this.notice(
				"info",
				"OAuth MCP servers are currently attached only to the built-in Toad Agent; ACP needs the planned Toad-owned refresh proxy.",
			);
		}
		const configured = resolved.filter(
			(server) => server.type !== "http" || server.auth.mode !== "oauth",
		).map((server) =>
			server.type === "stdio"
				? {
						name: server.name,
						command: server.command,
						args: server.args,
						env: Object.entries(server.env ?? {}).map(([name, value]) => ({ name, value })),
					}
				: {
						type: "http",
						name: server.name,
						url: server.url,
						// ACP requires `headers` on http servers, as name/value pairs.
						// An entry without it fails the adapter's schema union and is
						// silently dropped (vecSkipError) — the server just never
						// arrives, with nothing logged on either side.
						headers: Object.entries(server.headers ?? {}).map(([name, value]) => ({ name, value })),
					},
		);
		const verdict = sidecarVerdict(this.persona.backendId);
		if (!verdict.attach) {
			this.sidecarAttached = false;
			/* Said unconditionally. The `verdict.reason &&` that used to guard this
			 * was the silent half of the bug: the default deny carried no reason,
			 * so the one backend shape nobody had tested lost every Toad tool with
			 * nothing said in the transcript and nothing said anywhere else. The
			 * reason is required now, so the notice is too. */
			if (!this.compatNoticeEmitted) {
				this.compatNoticeEmitted = true;
				this.notice(
					"info",
					`Teammate tools were not attached to ${this.persona.backendId}: ${verdict.reason}.`,
				);
			}
			this.recordTools(resolved, verdict, false);
			return configured;
		}
		const sidecar = sidecarDescriptor({
			personaId: this.options?.scope?.personaId ?? this.persona.id,
			token: this.bridgeToken,
		});
		this.sidecarAttached = Boolean(sidecar);
		this.recordTools(resolved, verdict, Boolean(sidecar));
		return sidecar ? [sidecar, ...configured] : configured;
	}

	/**
	 * The tool ledger for an ACP teammate, which is a study in what Toad does
	 * not know.
	 *
	 * Toad is not the MCP client here: it hands over descriptors and the backend
	 * spawns the servers itself, so for a stdio server the honest state is
	 * `declared` — Toad asked, and never hears whether it worked. The rows that
	 * can say more are the ones Toad hosts. A plugin's tools ride a Toad-owned
	 * HTTP endpoint, so an `initialize` arriving on this teammate's path is proof
	 * the backend attached, and its absence afterwards is a verified absence with
	 * a cause instead of a shrug.
	 */
	private recordTools(
		resolved: McpRuntimeServerConfig[],
		verdict: { attach: boolean; reason: string },
		sidecarPresent: boolean,
	): void {
		const ledger = new ToolLedger(this.persona.id, "acp", this.persona.backendId);
		ledger.declared(
			"builtin",
			this.persona.backendId,
			"(the backend's own tools)",
			`${this.persona.backendId} runs in its own process with its own tools; Toad does not enumerate them`,
		);

		const toadNames = TOAD_TOOLS.map((tool) => tool.name);
		if (!bridgeAttachmentEnabled()) {
			ledger.all(
				"absent",
				"toad",
				"Toad",
				toadNames,
				"this Toad does not own the bridge socket — another Toad on this machine holds it, so the sidecar cannot be served",
			);
		} else if (!verdict.attach) {
			ledger.all("absent", "toad", "Toad", toadNames, verdict.reason);
		} else if (!sidecarPresent) {
			ledger.all(
				"absent",
				"toad",
				"Toad",
				toadNames,
				"the bundled MCP sidecar was not found on disk, so there was nothing to hand the backend — run `hutch run sidecar`",
			);
		} else {
			ledger.all(
				"declared",
				"toad",
				"Toad",
				toadNames,
				`handed to ${this.persona.backendId} as the "toad" MCP server; the sidecar's bridge connection is the proof it was really spawned`,
			);
		}

		for (const server of resolved) {
			/* A plugin's rows come from the plugin module, which knows the manifest
			 * and can therefore name a tool that is absent because the process is
			 * down. This loop only knows a server was handed over. */
			if (isPluginServerId(server.id)) continue;
			const oauth = server.type === "http" && server.auth.mode === "oauth";
			const source = server.id.startsWith("computer:") ? "computer" : "mcp";
			if (oauth) {
				ledger.absent(
					source,
					server.name,
					server.id,
					`${server.name} authenticates with OAuth, which currently reaches only the built-in Toad Agent — ACP needs the planned Toad-owned refresh proxy`,
				);
				continue;
			}
			ledger.declared(
				source,
				server.name,
				server.id,
				`handed to ${this.persona.backendId} as a descriptor; an ACP backend spawns its own MCP servers and does not report the tools it loaded`,
			);
		}
		for (const id of missingPolicyServers(this.persona)) {
			ledger.absent(
				"mcp",
				id,
				id,
				`this teammate's MCP policy names the server ${id}, which no longer exists in app settings — every tool it supplied is gone`,
			);
		}
		if (!this.persona.computer?.enabled) {
			ledger.absent(
				"computer",
				"computer",
				"computer",
				"the computer capability is off for this teammate; turn it on in its settings",
			);
		}
		ledger.absent(
			"search",
			"Toad",
			"web_search",
			"Toad's built-in web search is a Toad Agent tool; an ACP backend brings its own search or none",
		);
		ledger.absent(
			"subagent",
			"Toad",
			"subagent",
			"Toad subagents are a Toad Agent feature; an ACP backend runs its own",
		);
		for (const row of pluginToolRows(this.persona, "acp")) ledger.add(row);
		ledger.publish();
	}

	async stop(): Promise<void> {
		revokeBridgeScope(this.bridgeToken);
		this.flushMessage();
		this.patchInfo({ state: "stopped" });
		this.settleAllPermissions("cancelled");
		this.shutdown.resolve();
		try {
			await Promise.race([
				this.connectionDone ?? Promise.resolve(),
				new Promise((r) => setTimeout(r, 1500)),
			]);
		} catch {
			/* ignore */
		}
		this.proc?.kill();
	}

	// -- turns --------------------------------------------------------------

	/**
	 * Runs one turn immediately and resolves once it ends.
	 *
	 * This bypasses the queue/steer machinery below, which exists for the
	 * human composer. A peer session drives its own turn-taking — one
	 * exchange at a time, nothing else calling in — and needs to await
	 * completion directly the way `session/prompt` itself does.
	 */
	async prompt(text: string, attachments: Attachment[] = [], shown = text): Promise<void> {
		if (!this.ctx || !this.info.sessionId) throw new Error("Session is not ready");
		await this.runTurn([this.record(text, attachments, shown)]);
	}

	/**
	 * A message sent the ordinary way: written to the transcript at once, then
	 * queued. If a turn is already running, it waits and — together with
	 * anything else sent during the same busy stretch — becomes a single next
	 * turn the moment this one ends on its own. Nothing here interrupts.
	 */
	send(text: string, attachments: Attachment[] = [], shown = text): void {
		if (!this.ctx || !this.info.sessionId) throw new Error("Session is not ready");
		this.queue.push(this.record(text, attachments, shown));
		this.pump();
	}

	/**
	 * A message sent to redirect, not to follow up. Written to the transcript
	 * at once, same as `send`, but it cancels whatever turn is running and
	 * jumps ahead of the ordinary queue: it gets its own turn, alone, the
	 * moment the cancellation lands. Anything already queued behind it still
	 * follows afterward, untouched.
	 */
	steer(text: string, attachments: Attachment[] = [], shown = text): void {
		if (!this.ctx || !this.info.sessionId) throw new Error("Session is not ready");
		this.priority = this.record(text, attachments, shown);
		if (this.info.state === "thinking") {
			void this.cancel();
		} else {
			this.pump();
		}
	}

	/**
	 * Toad's own words to the agent, queued like `send` but never written to
	 * the transcript. The briefing still rides along if this is the first
	 * thing said on the connection.
	 */
	nudge(text: string): void {
		if (!this.ctx || !this.info.sessionId) throw new Error("Session is not ready");
		this.queue.push({ text, attachments: [] });
		this.pump();
	}

	/**
	 * Writes the user's turn to the transcript immediately — sending should
	 * feel instant regardless of whether the agent is free to look at it yet.
	 * Captures the handoff here too, before this message joins history, so a
	 * message that has to wait its turn cannot end up quoted back at the agent
	 * inside its own handoff.
	 *
	 * `shown` exists because what the model has to receive is not always what
	 * was said: a peer message travels wrapped in an envelope that fences it
	 * off from the agent's own instructions, and that scaffolding is Toad's,
	 * not the sender's, so the thread keeps the message alone.
	 */
	private record(text: string, attachments: Attachment[], shown = text): QueueItem {
		if (!this.handoffCaptured && !this.info.contextRestored) {
			this.handoffCaptured = true;
			this.pendingHandoff = conversationHandoffBlock(this.emit.history(), {
				tools: this.sidecarAttached,
			});
		}
		this.emit.appendEvent({
			kind: "user",
			id: randomUUID(),
			ts: now(),
			text: shown,
			...(attachments.length > 0 ? { attachments } : {}),
		});
		return { text, attachments };
	}

	/**
	 * Starts the next turn, if one is due and none is already running.
	 *
	 * Called from `send`/`steer`, where a turn already in flight is exactly
	 * the case that should do nothing — its own completion will pump again.
	 */
	private pump(): void {
		if (this.info.state === "thinking") return;
		this.dispatchNext();
	}

	/**
	 * The unguarded half of `pump`, for the one caller that already knows no
	 * turn is running: a turn's own completion, still inside `runTurn`'s
	 * `finally`, wants to hand off to the next batch immediately rather than
	 * going through the "is one already running" check — at that point
	 * `state` has not been reset to `ready` yet on purpose, so `pump` itself
	 * would see "thinking" and wrongly do nothing.
	 */
	private dispatchNext(): void {
		if (this.priority) {
			const next = this.priority;
			this.priority = null;
			void this.runTurn([next]);
			return;
		}
		if (this.queue.length > 0) {
			void this.runTurn(this.queue.splice(0));
		}
	}

	/** Runs one `session/prompt` for one or more queued messages at once. */
	private async runTurn(items: QueueItem[]): Promise<void> {
		if (!this.ctx || !this.info.sessionId) return;
		this.patchInfo({ state: "thinking" });

		/* The briefing rides along with the first thing said on this connection,
		 * which is the earliest ACP will carry it — session/new takes no system
		 * prompt. It is not written to the transcript, because Toad explaining
		 * itself to the agent is machinery, not conversation. */
		const preamble = this.briefed
			? []
			: [
					this.options?.briefing?.() ??
						houseStyleBlock({ teammateTools: this.sidecarAttached }),
					...(this.pendingHandoff === undefined ? [] : [this.pendingHandoff]),
				];
		this.briefed = true;
		this.pendingHandoff = undefined;

		// Attachments lead each message the way they do in a mail client, and
		// each queued message keeps its own attachments beside it rather than
		// all of them being pooled at the front of the batch.
		const blocks = items.flatMap((item) => [
			...item.attachments.map((a) => this.blockFor(a)),
			{ type: "text", text: item.text },
		]);

		try {
			const res = (await this.ctx.request("session/prompt", {
				sessionId: this.info.sessionId,
				prompt: [...preamble, ...blocks],
			})) as { stopReason: string; usage?: Record<string, number> };

			this.flushMessage();
			this.emit.appendEvent({
				kind: "turn",
				id: randomUUID(),
				ts: now(),
				stopReason: res.stopReason,
				usage: res.usage,
			});
			if (!this.checkpointed) {
				try {
					this.emit.sessionCheckpointed(this.persona.backendId, this.info.sessionId);
					this.checkpointed = true;
				} catch (err) {
					this.notice("error", `Could not save session continuity: ${short(err)}`);
				}
			}
		} catch (err) {
			this.flushMessage();
			this.notice("error", `Turn failed: ${short(err)}${this.stderrHint()}`);
		} finally {
			// A cancelled or failed turn can leave a tool call with no final
			// word on how it went; without a status it would spin forever.
			this.settleInterruptedTools();
			// Staying in "thinking" straight into the next batch reads as one
			// continuous stretch of work rather than flickering through ready.
			if (this.priority || this.queue.length > 0) {
				this.dispatchNext();
			} else {
				this.patchInfo({ state: "ready" });
			}
		}
	}

	/** Resolves any tool call a turn left open with no word on how it went. */
	private settleInterruptedTools(): void {
		for (const [id, call] of this.toolCalls) {
			if (call.status !== "pending" && call.status !== "in_progress") continue;
			const settled = { ...call, status: "failed" as const };
			this.toolCalls.set(id, settled);
			this.emit.updateEvent(settled);
		}
	}

	/**
	 * One attachment as a prompt content block.
	 *
	 * An image is inlined, but only for an agent that said it takes images —
	 * otherwise the bytes are wasted and some agents reject the block outright.
	 * Everything else is a link, which for a coding agent is the better shape
	 * anyway: it already has the filesystem, and a path costs nothing to send.
	 * The fallback is the same link written out in words, because an agent that
	 * cannot parse the block can still read the sentence.
	 */
	private blockFor(item: Attachment): Record<string, unknown> {
		const uri = pathToFileURL(item.path).href;

		if (item.kind === "image" && item.mimeType && this.info.capabilities.image) {
			try {
				return {
					type: "image",
					mimeType: item.mimeType,
					data: readFileSync(item.path).toString("base64"),
					uri,
				};
			} catch (err) {
				// A file that moved between attaching and sending is still worth
				// naming: the agent can say so, where a dropped block cannot.
				this.notice("warn", `Could not read ${item.name}: ${short(err)}`);
				return { type: "text", text: `[attached ${item.name}, unreadable at ${item.path}]` };
			}
		}

		return { type: "resource_link", uri, name: item.name, mimeType: item.mimeType };
	}

	async cancel(): Promise<void> {
		this.settleAllPermissions("cancelled");
		if (!this.ctx || !this.info.sessionId) return;
		// A cancelled turn still resolves session/prompt, so state is settled there.
		await this.ctx.notify("session/cancel", { sessionId: this.info.sessionId });
	}

	async setMode(modeId: string): Promise<SessionInfo> {
		if (!this.ctx || !this.info.sessionId) throw new Error("Session is not ready");
		if (this.modeConfigId) return this.setConfig(this.modeConfigId, modeId);
		await this.ctx.request("session/set_mode", { sessionId: this.info.sessionId, modeId });
		this.patchInfo({ currentModeId: modeId });
		return this.info;
	}

	/**
	 * Model switching moved to the generic config-option surface, but agents
	 * still ship the older dedicated method, so try both.
	 */
	async setModel(modelId: string): Promise<SessionInfo> {
		if (!this.ctx || !this.info.sessionId) throw new Error("Session is not ready");
		if (this.modelConfigId) return this.setConfig(this.modelConfigId, modelId);
		const sessionId = this.info.sessionId;
		try {
			await this.ctx.request("session/set_model", { sessionId, modelId } as never);
		} catch {
			await this.setConfig("model", modelId);
			return this.info;
		}
		this.patchInfo({ currentModelId: modelId });
		return this.info;
	}

	async setConfig(configId: string, value: string): Promise<SessionInfo> {
		if (!this.ctx || !this.info.sessionId) throw new Error("Session is not ready");
		const res = (await this.ctx.request("session/set_config_option", {
			sessionId: this.info.sessionId,
			configId,
			value,
		} as never)) as { configOptions?: SessionConfigOption[] } | undefined;
		if (Array.isArray(res?.configOptions)) {
			this.applyDisposition(this.info.sessionId, dispositionOf({ configOptions: res.configOptions }));
		} else if (configId === this.modelConfigId) {
			this.patchInfo({ currentModelId: value });
		} else if (configId === this.modeConfigId) {
			this.patchInfo({ currentModeId: value });
		} else {
			this.patchInfo({
				configs: this.info.configs.map((picker) =>
					picker.id === configId ? { ...picker, currentId: value } : picker,
				),
			});
		}
		return this.info;
	}

	answerPermission(requestId: string, optionId: string): boolean {
		return this.settlePermission(requestId, { decision: "selected", optionId });
	}

	private settleAllPermissions(decision: "cancelled" | "expired"): void {
		for (const requestId of [...this.pendingPermissions.keys()]) {
			this.settlePermission(requestId, { decision });
		}
	}

	/** The only path that resolves, records, removes, and disarms a live request. */
	private settlePermission(requestId: string, settlement: PermissionSettlement): boolean {
		const pending = this.pendingPermissions.get(requestId);
		if (!pending) return false;

		this.pendingPermissions.delete(requestId);
		clearTimeout(pending.timer);
		this.emit.updateEvent({
			...pending.event,
			ts: now(),
			decision: settlement.decision === "selected" ? settlement.optionId : settlement.decision,
			...(settlement.decision === "selected"
				? {
						decidedOptionName: pending.event.options.find(
							(option) => option.optionId === settlement.optionId,
						)?.name,
					}
				: {}),
		});
		pending.deferred.resolve(settlement);
		return true;
	}

	// -- update translation -------------------------------------------------

	/**
	 * What the agent is actually asking to be allowed to do.
	 *
	 * The `toolCall` on a permission request is a partial that points back at a
	 * call already announced over session/update, so on its own it can carry
	 * nothing but an id and a kind. "The agent is asking for permission" is not
	 * a question anyone can answer, so this recovers the detail: the command if
	 * there is one, otherwise the announced title, otherwise at least the kind
	 * of thing being attempted.
	 */
	private describeRequest(toolCall?: PermissionToolCall): string {
		const known = toolCall?.toolCallId ? this.toolCalls.get(toolCall.toolCallId) : undefined;

		const command = toolCall?.rawInput?.command;
		if (typeof command === "string" && command.trim()) return `Run ${command.trim()}`;

		// Agents title an edit "Editing files" and leave which file to the
		// locations, which is the one detail the answer turns on.
		const where = known?.locations?.[0]?.split("/").pop();
		const named = (what: string) => (where && !what.includes(where) ? `${what} — ${where}` : what);

		const title = toolCall?.title || known?.title;
		if (title) return named(title);

		const kind = toolCall?.kind ?? known?.toolKind;
		if (!kind) return "The agent is asking for permission";
		return named(`Allow the agent to ${PERMISSION_VERBS[kind] ?? `use ${kind}`}`);
	}

	private async handlePermission(
		params: Record<string, unknown>,
	): Promise<{ outcome: { outcome: "selected"; optionId: string } | { outcome: "cancelled" } }> {
		const options = (params.options ?? []) as Array<{
			optionId: string;
			name: string;
			kind?: string;
		}>;

		const requestId = randomUUID();
		const eventId = `perm:${requestId}`;
		const title = this.describeRequest(params.toolCall as PermissionToolCall | undefined);

		const event: Extract<TranscriptEvent, { kind: "permission" }> = {
			kind: "permission",
			id: eventId,
			ts: now(),
			requestId,
			title,
			options: options.map((o) => ({ optionId: o.optionId, name: o.name, kind: o.kind })),
		};
		const pending = deferred<PermissionSettlement>();
		const timeoutMs = this.options?.permissionTimeoutMs ?? ACP_PERMISSION_TIMEOUT_MS;
		const timer = setTimeout(
			() => this.settlePermission(requestId, { decision: "expired" }),
			timeoutMs,
		);
		timer.unref?.();
		this.pendingPermissions.set(requestId, { deferred: pending, event, timer });

		this.flushMessage();
		this.emit.appendEvent(event);

		const settlement = await pending.promise;
		return settlement.decision === "selected"
			? { outcome: { outcome: "selected", optionId: settlement.optionId } }
			: { outcome: { outcome: "cancelled" } };
	}

	private handleUpdate(params: Record<string, unknown>): void {
		if (this.replaying) return;

		const update = params.update as Record<string, unknown> | undefined;
		if (!update) return;
		const kind = update.sessionUpdate as string;

		switch (kind) {
			case "agent_message_chunk":
				this.appendChunk("agent", update);
				return;
			case "agent_thought_chunk":
				this.appendChunk("thought", update);
				return;

			case "tool_call": {
				this.flushMessage();
				const toolCallId = String(update.toolCallId ?? randomUUID());
				const event: Extract<TranscriptEvent, { kind: "tool" }> = {
					kind: "tool",
					id: `tool:${toolCallId}`,
					ts: now(),
					toolCallId,
					title: String(update.title ?? "Tool call"),
					toolKind: update.kind as string | undefined,
					status: normalizeStatus(update.status),
					locations: extractLocations(update.locations),
					output: extractOutput(update.content),
				};
				this.toolCalls.set(toolCallId, event);
				this.emit.appendEvent(event);
				return;
			}

			case "tool_call_update": {
				const toolCallId = String(update.toolCallId ?? "");
				if (!toolCallId) return;
				// Absent means unchanged, so everything falls back to what was last
				// written — including `ts`, which is when the call started.
				const previous = this.toolCalls.get(toolCallId);
				const event: Extract<TranscriptEvent, { kind: "tool" }> = {
					kind: "tool",
					id: `tool:${toolCallId}`,
					ts: previous?.ts ?? now(),
					toolCallId,
					title: update.title === undefined ? previous?.title ?? "" : String(update.title),
					toolKind: (update.kind as string | undefined) ?? previous?.toolKind,
					status:
						update.status === undefined
							? previous?.status ?? "in_progress"
							: normalizeStatus(update.status),
					locations:
						update.locations === undefined ? previous?.locations : extractLocations(update.locations),
					output: update.content === undefined ? previous?.output : extractOutput(update.content),
				};
				this.toolCalls.set(toolCallId, event);
				this.emit.updateEvent(event);
				return;
			}

			case "plan": {
				this.flushMessage();
				const entries = ((update.entries ?? []) as Array<Record<string, unknown>>).map((e) => ({
					content: String(e.content ?? ""),
					status: String(e.status ?? "pending"),
					priority: e.priority as string | undefined,
				}));
				this.emit.updateEvent({
					kind: "plan",
					id: `plan:${this.info.sessionId ?? "current"}`,
					ts: now(),
					entries,
				});
				return;
			}

			case "available_commands_update": {
				const commands = ((update.availableCommands ?? []) as Array<Record<string, unknown>>).map(
					(c): SlashCommand => ({
						name: String(c.name ?? ""),
						description: c.description as string | undefined,
						hint: (c.input as { hint?: string } | undefined)?.hint,
					}),
				);
				this.patchInfo({ slashCommands: commands });
				return;
			}

			case "current_mode_update":
				this.patchInfo({ currentModeId: String(update.currentModeId ?? "") });
				return;

			case "config_option_update": {
				const options = update.configOptions as SessionConfigOption[] | undefined;
				if (!Array.isArray(options) || !this.info.sessionId) return;
				this.applyDisposition(this.info.sessionId, dispositionOf({ configOptions: options }));
				return;
			}

			default:
				return;
		}
	}

	private appendChunk(kind: "agent" | "thought", update: Record<string, unknown>): void {
		const content = update.content as { type?: string; text?: string } | undefined;
		if (content?.type !== "text" || typeof content.text !== "string") return;

		if (!this.openMessage || this.openMessage.kind !== kind) {
			this.flushMessage();
			this.openMessage = { eventId: randomUUID(), kind, text: "" };
		}
		this.openMessage.text += content.text;
		this.emit.delta(this.openMessage.eventId, kind, content.text);
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

	// -- process plumbing ---------------------------------------------------

	private pumpStderr(): void {
		const stderr = this.proc?.stderr;
		if (!stderr || typeof stderr === "number") return;
		void (async () => {
			const reader = (stderr as ReadableStream<Uint8Array>).getReader();
			const decoder = new TextDecoder();
			try {
				for (;;) {
					const { done, value } = await reader.read();
					if (done) break;
					const text = decoder.decode(value, { stream: true }).trim();
					if (!text) continue;
					this.stderrTail.push(text);
					if (this.stderrTail.length > 20) this.stderrTail.shift();
				}
			} catch {
				/* stream closed */
			}
		})();
	}

	private watchExit(): void {
		const proc = this.proc;
		if (!proc) return;
		void proc.exited.then((code) => {
			if (this.info.state === "stopped") return;
			this.flushMessage();
			this.patchInfo({ state: "stopped" });
			if (code !== 0) {
				this.notice(
					"error",
					`The ${this.persona.backendId} backend exited (code ${code}).${this.stderrHint()}`,
				);
			}
			this.shutdown.resolve();
		});
	}

	private stderrHint(): string {
		const tail = this.stderrTail.slice(-3).join(" ").trim();
		return tail ? ` Backend said: ${tail}` : "";
	}

	updatePersona(persona: Persona): void {
		this.persona = persona;
	}
}

// -- helpers ---------------------------------------------------------------

type InitializeResult = {
	protocolVersion?: number;
	agentInfo?: { name?: string; version?: string };
	agentCapabilities?: {
		loadSession?: boolean;
		mcpCapabilities?: { http?: boolean; sse?: boolean };
		promptCapabilities?: { image?: boolean; embeddedContext?: boolean };
		sessionCapabilities?: Record<string, unknown> & { resume?: unknown; fork?: unknown };
	};
};

type NewSessionResult = {
	sessionId?: string;
	models?: { currentModelId?: string; availableModels?: Array<{ modelId: string; name: string }> };
	modes?: {
		currentModeId?: string;
		availableModes?: Array<{ id: string; name: string; description?: string }>;
	};
	configOptions?: SessionConfigOption[] | null;
};

function normalizeStatus(value: unknown): ToolStatus {
	switch (value) {
		case "in_progress":
			return "in_progress";
		case "completed":
			return "completed";
		case "failed":
			return "failed";
		default:
			return "pending";
	}
}

function extractLocations(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const paths = value
		.map((l) => (l as { path?: string }).path)
		.filter((p): p is string => typeof p === "string");
	return paths.length > 0 ? paths : undefined;
}

function extractOutput(value: unknown): ToolOutput[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const out: ToolOutput[] = [];
	for (const raw of value) {
		const item = raw as Record<string, unknown>;
		if (item.type === "diff" && typeof item.newText === "string") {
			out.push({
				type: "diff",
				path: String(item.path ?? ""),
				oldText: (item.oldText as string | null | undefined) ?? null,
				newText: item.newText,
			});
			continue;
		}
		const content = item.content as { type?: string; text?: string } | undefined;
		if (content?.type === "text" && typeof content.text === "string") {
			out.push({ type: "text", text: content.text });
			continue;
		}
		if (item.type === "text" && typeof item.text === "string") {
			out.push({ type: "text", text: item.text });
		}
	}
	return out.length > 0 ? out : undefined;
}

function short(err: unknown): string {
	const message = err instanceof Error ? err.message : String(err);
	return message.length > 200 ? `${message.slice(0, 200)}…` : message;
}

/** ConfigChoice is re-exported for callers that only need the option shape. */
export type { ConfigChoice };
