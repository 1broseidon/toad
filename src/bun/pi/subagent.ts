import {
	DefaultResourceLoader,
	SessionManager,
	createAgentSession,
	defineTool,
	type AgentSession,
	type ModelRuntime,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { appendFileSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { ResolvedSubagent } from "../../shared/types";
import {
	GENERIC_SUBAGENT_KIND,
	findSubagent,
	subagentKindList,
} from "../../shared/subagents";
import { PI_DIR } from "../paths";
import { gateChildComputer, releaseComputer } from "./computer-lease";
import { contextFilesInWorkspace, withoutHomeAgentsSkills } from "./isolation";

/** Public tool name — same word as the settings roster. */
export const SUBAGENT_TOOL_NAME = "subagent";
export { GENERIC_SUBAGENT_KIND };

export const MAX_LIVE_SUBAGENTS = 4;
/**
 * Generous by design: a run can spend long minutes parked behind the
 * computer lease or a `request_human` card (itself up to 600s), and a wait
 * must not be a death sentence. The ceiling exists to kill runaways, not to
 * pace honest work.
 */
export const SUBAGENT_TIMEOUT_MS = 30 * 60_000;
const MAX_PROMPT = 24_000;
const MAX_LABEL = 80;

const CODING_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];

export type SubagentHost = {
	cwd: string;
	/** Keys the computer lease this run shares with its teammate. */
	personaId: string;
	teammateName: string;
	goal: string;
	model: AgentSession["model"];
	thinkingLevel: AgentSession["thinkingLevel"];
	runtime: ModelRuntime;
	/** MCP tools already connected on the parent; the subagent does not reconnect. */
	extraTools: ToolDefinition[];
	/** Bridge tools an arm inherits (`ARM_TOOL_POLICY`): request_human, get_context. */
	armTools: ToolDefinition[];
	/** Kinds this teammate may choose, including the built-in task runner. */
	roster: ResolvedSubagent[];
};

export type SubagentResult =
	| { ok: true; report: string }
	| {
			ok: false;
			reason: "aborted" | "timeout" | "no_model" | "busy" | "failed";
			detail: string;
			/**
			 * What survived the failure: the run's last written text and its log
			 * path. A child that did real work and then lost its final model
			 * call must not read as a child that did nothing — edits are on
			 * disk either way, and the parent needs to know which.
			 */
			partial?: string;
	  };

export type SubagentToolHost = {
	context(): SubagentHost | undefined;
	begin(): "ok" | "busy";
	end(): void;
	track(session: AgentSession): void;
	untrack(session: AgentSession): void;
};

/**
 * What a generic subagent is allowed to know.
 *
 * The parent's house style is the opposite of this: it exists so a teammate
 * says "on it" in the chat. A subagent's tokens never land there — only its
 * last message is returned as a tool result — so greeting, acknowledging,
 * and narrating are wasted tokens that also teach the parent the wrong rhythm.
 *
 * It also does not see the user's conversation. The parent has to put
 * everything the job needs in the prompt, the same way `message_teammate`
 * sends one self-contained message.
 */
export function genericSubagentPrompt(
	host: Pick<SubagentHost, "teammateName" | "goal">,
	spec?: Pick<ResolvedSubagent, "name" | "prompt">,
): string {
	const role = spec?.name?.trim();
	const goal = host.goal.trim();
	const who = role
		? goal
			? `You are ${role}, a subagent working on behalf of ${host.teammateName}, who was created for this:\n\n${goal}`
			: `You are ${role}, a subagent working on behalf of ${host.teammateName}.`
		: goal
			? `You are a generic subagent working on behalf of ${host.teammateName}, who was created for this:\n\n${goal}`
			: `You are a generic subagent working on behalf of ${host.teammateName}.`;
	const extra = spec?.prompt?.trim()
		? `\n\nThe operator briefed you as follows:\n\n${spec.prompt.trim()}`
		: "";

	return `${who}

You are not speaking to the user. You were given one task by that teammate. Complete it with your tools.

You work as that teammate's own hands: the same workspace, the same tools, its computer if it has one. Prefer your workspace tools (bash, read, write) for ordinary work; touch the computer only when the task itself needs the desktop. If the computer is in use when you reach for it, your call waits its turn — a wait is normal, not a failure.

Do not greet, do not acknowledge, do not narrate progress. Intermediate chatter is discarded; only your final message is returned.

When you are done, write a self-contained report: what you found or changed, and anything the teammate needs to know to continue. If you failed, say what stopped you. Do not recap every file you opened.${extra}`;
}

export function resolveSubagentKind(
	value: unknown,
	roster: readonly ResolvedSubagent[],
): { ok: true; spec: ResolvedSubagent } | { ok: false; detail: string } {
	const id =
		value === undefined || value === ""
			? GENERIC_SUBAGENT_KIND
			: typeof value === "string"
				? value
				: undefined;
	const spec = typeof id === "string" ? findSubagent(roster, id) : undefined;
	if (spec) return { ok: true, spec };
	const shown = typeof value === "string" ? value : JSON.stringify(value);
	return {
		ok: false,
		detail: `Unknown subagent kind ${shown}. Available: ${subagentKindList(roster) || GENERIC_SUBAGENT_KIND}.`,
	};
}

/**
 * `provider/id`, the same id Toad's model picker uses.
 *
 * `undefined` means inherit the parent's model. A later specialized kind can
 * pick its own default and still let this override win.
 */
export function resolveSubagentModel(
	runtime: ModelRuntime,
	choiceId: unknown,
): { ok: true; model?: AgentSession["model"] } | { ok: false; detail: string } {
	if (choiceId === undefined) return { ok: true };
	if (typeof choiceId !== "string" || choiceId.length === 0) {
		return { ok: false, detail: "model must be a provider/id string." };
	}
	const slash = choiceId.indexOf("/");
	if (slash <= 0 || slash === choiceId.length - 1) {
		return { ok: false, detail: "model must be provider/id, e.g. anthropic/claude-sonnet-4-6." };
	}
	const model = runtime.getModel(choiceId.slice(0, slash), choiceId.slice(slash + 1));
	if (!model) return { ok: false, detail: `Unknown model ${choiceId}.` };
	return { ok: true, model };
}

function formatResult(result: SubagentResult): string {
	if (result.ok) return result.report;
	const salvage = result.partial ? `\n\n${result.partial}` : "";
	switch (result.reason) {
		case "aborted":
			return `The subagent was cancelled.${salvage}`;
		case "timeout":
			return `The subagent timed out before it finished.${salvage}`;
		case "no_model":
			return "The subagent has no model to run with.";
		case "busy":
			return result.detail;
		case "failed":
			return `The subagent failed: ${result.detail}${salvage}`;
	}
}

function textResult(text: string) {
	return { content: [{ type: "text" as const, text }], details: {} };
}

/**
 * The action log: every tool call a subagent makes — files, shell, and
 * computer alike — one JSON line each, in a file the parent can `read`
 * afterwards to audit or steer. This is the parent's record — the human's
 * is the drawer's recent frames. Attribution lives here and nowhere
 * user-facing: an arm's work is the teammate's own. Waits for the computer
 * lease get their own lines, so a slow run shows *where* the time went.
 */
const ACTION_LOG_DIR = join(PI_DIR, "subagent-actions");
const MAX_ACTION_LOGS = 10;
const MAX_LOGGED_ARGS = 400;

function actionLogPath(runId: string): string {
	return join(ACTION_LOG_DIR, `${runId}.jsonl`);
}

function logToolCall(path: string, tool: string, params: unknown): void {
	try {
		mkdirSync(ACTION_LOG_DIR, { recursive: true });
		const args = params && typeof params === "object" ? (params as Record<string, unknown>) : {};
		appendFileSync(
			path,
			`${JSON.stringify({
				ts: new Date().toISOString(),
				tool,
				...(typeof args.action === "string" ? { action: args.action } : {}),
				args: JSON.stringify(args).slice(0, MAX_LOGGED_ARGS),
			})}\n`,
		);
	} catch {
		// An unlogged click must never fail the click.
	}
}

/** Last `MAX_ACTION_LOGS` runs stay; older logs go. */
function pruneActionLogs(): void {
	try {
		const logs = readdirSync(ACTION_LOG_DIR)
			.filter((name) => name.endsWith(".jsonl"))
			.map((name) => ({ name, at: statSync(join(ACTION_LOG_DIR, name)).mtimeMs }))
			.sort((a, b) => b.at - a.at);
		for (const { name } of logs.slice(MAX_ACTION_LOGS)) {
			rmSync(join(ACTION_LOG_DIR, name), { force: true });
		}
	} catch {
		// Pruning is hygiene, not correctness.
	}
}

/**
 * One silent nested pi session, same workspace, no chat.
 *
 * pi ships without sub-agents on purpose. This is Toad's own: a second
 * `createAgentSession` whose events are never subscribed to the parent's
 * emitters, so a write, a thought, or an "on it" cannot appear in the
 * teammate's transcript. The parent sees one `subagent` tool call.
 *
 * The session is in-memory so a subagent does not become a checkpoint the
 * teammate would restore into. It does not get `subagent` itself — one
 * level of nesting is the whole system for now.
 *
 * `kind` picks an entry from this teammate's roster. generic is always
 * there; extras the operator added bring their own brief and optional model.
 */
export async function runSubagent(
	host: SubagentHost,
	prompt: string,
	options?: {
		spec?: ResolvedSubagent;
		signal?: AbortSignal;
		/** The transcript label; also names this run when it holds the computer. */
		label?: string;
		track?: (session: AgentSession) => void;
		untrack?: (session: AgentSession) => void;
	},
): Promise<SubagentResult> {
	if (options?.signal?.aborted) {
		return { ok: false, reason: "aborted", detail: "cancelled" };
	}
	if (!host.model) {
		return { ok: false, reason: "no_model", detail: "no model" };
	}

	const loader = new DefaultResourceLoader({
		cwd: host.cwd,
		agentDir: PI_DIR,
		noExtensions: true,
		noPromptTemplates: true,
		noThemes: true,
		systemPromptOverride: () => genericSubagentPrompt(host, options?.spec),
		skillsOverride: ({ skills, diagnostics }) => ({
			skills: withoutHomeAgentsSkills(skills),
			diagnostics,
		}),
		agentsFilesOverride: ({ agentsFiles }) => ({
			agentsFiles: contextFilesInWorkspace(agentsFiles, host.cwd, PI_DIR),
		}),
	});
	await loader.reload();

	const runId = randomUUID();
	const label = options?.label?.trim() || options?.spec?.name || "subagent";
	const logPath = actionLogPath(runId);
	let logged = 0;
	const inherited = host.extraTools.filter((tool) => tool.name !== SUBAGENT_TOOL_NAME);
	const extraTools = [
		...gateChildComputer(host.personaId, runId, label, inherited, (tool, waitedMs) => {
			if (waitedMs < 100) return;
			logged += 1;
			logToolCall(logPath, tool, { action: "waited for the computer", waited_ms: waitedMs });
		}),
		...host.armTools,
	];
	const { session } = await createAgentSession({
		cwd: host.cwd,
		agentDir: PI_DIR,
		modelRuntime: host.runtime,
		resourceLoader: loader,
		model: host.model,
		thinkingLevel: host.thinkingLevel,
		customTools: extraTools,
		tools: [...CODING_TOOLS, ...extraTools.map((tool) => tool.name)],
		sessionManager: SessionManager.inMemory(host.cwd),
	});

	options?.track?.(session);

	const timeout = AbortSignal.timeout(SUBAGENT_TIMEOUT_MS);
	const signal = options?.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
	const abort = () => {
		void session.abort();
	};
	signal.addEventListener("abort", abort, { once: true });

	let failed: string | undefined;
	const unsubscribe = session.subscribe((event) => {
		if (event.type === "tool_execution_start") {
			logged += 1;
			logToolCall(logPath, event.toolName, event.args);
			return;
		}
		if (event.type !== "agent_end") return;
		const last = event.messages[event.messages.length - 1] as
			| { stopReason?: string; errorMessage?: string }
			| undefined;
		if (last?.stopReason === "error") {
			failed = last.errorMessage ?? "the model returned an error";
		}
	});

	const trail = () =>
		logged > 0
			? `(This run's ${logged} tool call${logged === 1 ? " is" : "s are"} logged at ${logPath}.)`
			: "";

	/* A failure after real work must carry the work out with it. The child's
	 * edits are on disk whether or not its final model call survived, so the
	 * parent gets whatever was last written plus the log — "failed" alone
	 * would read as "nothing happened", which is the one lie worse than
	 * losing the report. */
	const salvage = (): string | undefined => {
		const text = session.getLastAssistantText()?.trim();
		const bits: string[] = [];
		if (text) bits.push(`Before failing, its last written note was:\n${text.slice(0, 2_000)}`);
		if (logged > 0) bits.push(trail());
		return bits.length > 0 ? bits.join("\n\n") : undefined;
	};

	try {
		if (signal.aborted) {
			return resultForAbort(options?.signal, timeout, salvage());
		}
		await session.prompt(prompt);
		if (signal.aborted) {
			return resultForAbort(options?.signal, timeout, salvage());
		}
		if (failed) {
			return { ok: false, reason: "failed", detail: failed, partial: salvage() };
		}
		const report = session.getLastAssistantText()?.trim();
		const note = trail() ? `\n\n${trail()}` : "";
		return {
			ok: true,
			report:
				report && report.length > 0
					? `${report}${note}`
					: `The subagent finished without a report.${note}`,
		};
	} catch (error) {
		if (signal.aborted) {
			return resultForAbort(options?.signal, timeout, salvage());
		}
		const detail = error instanceof Error ? error.message : String(error);
		return { ok: false, reason: "failed", detail, partial: salvage() };
	} finally {
		releaseComputer(host.personaId, { kind: "child", runId, label });
		if (logged > 0) pruneActionLogs();
		signal.removeEventListener("abort", abort);
		unsubscribe();
		options?.untrack?.(session);
		try {
			await session.abort();
		} catch {
			/* already idle */
		}
		session.dispose();
	}
}

function resultForAbort(
	parent: AbortSignal | undefined,
	timeout: AbortSignal,
	partial?: string,
): SubagentResult {
	if (timeout.aborted && !parent?.aborted) {
		return { ok: false, reason: "timeout", detail: "timed out", partial };
	}
	return { ok: false, reason: "aborted", detail: "cancelled", partial };
}

function toolDescription(roster: readonly ResolvedSubagent[]): string {
	const kinds = roster
		.map((entry) => `\`${entry.id}\` (${entry.name}): ${entry.description}`)
		.join(" ");
	return (
		"Send a task to a subagent that works as your own hands and does not speak in the user's chat. " +
		"It has your workspace, the coding tools (read, bash, edit, write, grep, find, ls), the same MCP tools you do — your computer included — and request_human to summon the user when only a person can act. " +
		"It cannot message teammates, schedule work, or spawn another subagent. " +
		"Its drafts and tool calls stay off this conversation; you receive one report when it finishes. " +
		`At most ${MAX_LIVE_SUBAGENTS} run at once; further calls return busy. ` +
		"Subagents share your computer — one that needs it waits its turn behind you or another subagent — and share your files with no write coordination: keep parallel subagents on disjoint files, because a full-file write or shell redirect silently overwrites earlier work. " +
		`Kinds available to you: ${kinds} ` +
		"Omit `kind` for the task runner (`generic`). Pass `model` as provider/id to override the kind's model; omit it to use the kind's, or yours if the kind has none. " +
		"Use this for a bounded piece of work that would take many tool calls, or for pieces that can run at the same time. " +
		"Do not use it to talk to the user, and do not use it for something a single tool call would finish. " +
		"The subagent cannot see this conversation — put everything it needs in `prompt`. " +
		"Its work is your work: tell the user what you did, never that you delegated."
	);
}

/**
 * The tool the parent teammate calls. Not a Toad MCP method: ACP backends
 * already have their own ways to spawn work, and a sidecar `subagent` would
 * have to invent a runner those harnesses do not share.
 *
 * `roster` is baked into the description at session start. Kind checks read
 * the live host roster, so a teammate that has not restarted yet still
 * refuses a kind that is no longer configured.
 */
export function subagentTool(host: SubagentToolHost, roster: readonly ResolvedSubagent[]): ToolDefinition {
	return defineTool({
		name: SUBAGENT_TOOL_NAME,
		label: "Run a subagent",
		description: toolDescription(roster),
		promptSnippet: "Send a bounded piece of work to a silent subagent in this workspace.",
		promptGuidelines: [
			`Use subagent for work that would take many tool calls, or that can run while you do something else. At most ${MAX_LIVE_SUBAGENTS} run at once.`,
			`kind is one of: ${subagentKindList(roster)}. Omit it for the task runner. Pass model as provider/id to override; omit it to use the kind's model, or yours.`,
			"The subagent cannot see this conversation. Put everything it needs in the prompt.",
			"Parallel subagents share your files and your computer: keep them on disjoint files; computer work waits its turn.",
			"A subagent is your own hands. Wait for the report, then tell the user what you did — never announce that you delegated, and never narrate a subagent's progress.",
		],
		parameters: {
			type: "object",
			properties: {
				prompt: {
					type: "string",
					description: "The full task. Self-contained; the subagent cannot see this chat.",
				},
				label: {
					type: "string",
					description: "A few words for the transcript line, e.g. 'count ts files'.",
				},
				kind: {
					type: "string",
					description: `Which subagent to run. One of: ${subagentKindList(roster)}. Omit for the task runner.`,
				},
				model: {
					type: "string",
					description: "Model as provider/id. Overrides the kind's model. Omit to use the kind's, or this teammate's.",
				},
			},
			required: ["prompt"],
			additionalProperties: false,
		} as never,
		executionMode: "parallel",
		execute: async (_toolCallId, params, signal) => {
			const args = (params ?? {}) as Record<string, unknown>;
			const prompt = typeof args.prompt === "string" ? args.prompt : "";
			if (prompt.length === 0 || prompt.length > MAX_PROMPT) {
				return textResult("The subagent needs a prompt of 1–24000 characters.");
			}
			if (typeof args.label === "string" && args.label.length > MAX_LABEL) {
				return textResult("The label is too long (80 characters).");
			}

			const context = host.context();
			if (!context) {
				return textResult("The teammate is not ready to run a subagent.");
			}

			const kind = resolveSubagentKind(args.kind, context.roster);
			if (!kind.ok) return textResult(kind.detail);

			const fromCall = resolveSubagentModel(context.runtime, args.model);
			if (!fromCall.ok) return textResult(fromCall.detail);
			const fromSpec =
				fromCall.model || !kind.spec.modelId
					? { ok: true as const, model: undefined }
					: resolveSubagentModel(context.runtime, kind.spec.modelId);
			if (!fromSpec.ok) return textResult(fromSpec.detail);

			if (host.begin() === "busy") {
				return textResult(
					formatResult({
						ok: false,
						reason: "busy",
						detail: `Too many subagents are already going (max ${MAX_LIVE_SUBAGENTS}). Wait for one to finish or do the work yourself.`,
					}),
				);
			}

			try {
				return textResult(
					formatResult(
						await runSubagent(
							{ ...context, model: fromCall.model ?? fromSpec.model ?? context.model },
							prompt,
							{
								spec: kind.spec,
								label: typeof args.label === "string" ? args.label : undefined,
								signal,
								track: (session) => host.track(session),
								untrack: (session) => host.untrack(session),
							},
						),
					),
				);
			} finally {
				host.end();
			}
		},
	}) as ToolDefinition;
}
