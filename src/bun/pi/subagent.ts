import {
	DefaultResourceLoader,
	SessionManager,
	createAgentSession,
	defineTool,
	type AgentSession,
	type ModelRuntime,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { ResolvedSubagent } from "../../shared/types";
import {
	GENERIC_SUBAGENT_KIND,
	findSubagent,
	subagentKindList,
} from "../../shared/subagents";
import { PI_DIR } from "../paths";
import { contextFilesInWorkspace, withoutHomeAgentsSkills } from "./isolation";

/** Public tool name — same word as the settings roster. */
export const SUBAGENT_TOOL_NAME = "subagent";
export { GENERIC_SUBAGENT_KIND };

export const MAX_LIVE_SUBAGENTS = 4;
export const SUBAGENT_TIMEOUT_MS = 10 * 60_000;
const MAX_PROMPT = 24_000;
const MAX_LABEL = 80;

const CODING_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];

export type SubagentHost = {
	cwd: string;
	teammateName: string;
	goal: string;
	model: AgentSession["model"];
	thinkingLevel: AgentSession["thinkingLevel"];
	runtime: ModelRuntime;
	/** MCP tools already connected on the parent; the subagent does not reconnect. */
	extraTools: ToolDefinition[];
	/** Kinds this teammate may choose, including the built-in task runner. */
	roster: ResolvedSubagent[];
};

export type SubagentResult =
	| { ok: true; report: string }
	| {
			ok: false;
			reason: "aborted" | "timeout" | "no_model" | "busy" | "failed";
			detail: string;
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
	switch (result.reason) {
		case "aborted":
			return "The subagent was cancelled.";
		case "timeout":
			return "The subagent timed out before it finished.";
		case "no_model":
			return "The subagent has no model to run with.";
		case "busy":
			return result.detail;
		case "failed":
			return `The subagent failed: ${result.detail}`;
	}
}

function textResult(text: string) {
	return { content: [{ type: "text" as const, text }], details: {} };
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

	const extraTools = host.extraTools.filter((tool) => tool.name !== SUBAGENT_TOOL_NAME);
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
		if (event.type !== "agent_end") return;
		const last = event.messages[event.messages.length - 1] as
			| { stopReason?: string; errorMessage?: string }
			| undefined;
		if (last?.stopReason === "error") {
			failed = last.errorMessage ?? "the model returned an error";
		}
	});

	try {
		if (signal.aborted) {
			return resultForAbort(options?.signal, timeout);
		}
		await session.prompt(prompt);
		if (signal.aborted) {
			return resultForAbort(options?.signal, timeout);
		}
		if (failed) {
			return { ok: false, reason: "failed", detail: failed };
		}
		const report = session.getLastAssistantText()?.trim();
		return {
			ok: true,
			report: report && report.length > 0 ? report : "The subagent finished without a report.",
		};
	} catch (error) {
		if (signal.aborted) {
			return resultForAbort(options?.signal, timeout);
		}
		const detail = error instanceof Error ? error.message : String(error);
		return { ok: false, reason: "failed", detail };
	} finally {
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

function resultForAbort(parent: AbortSignal | undefined, timeout: AbortSignal): SubagentResult {
	if (timeout.aborted && !parent?.aborted) {
		return { ok: false, reason: "timeout", detail: "timed out" };
	}
	return { ok: false, reason: "aborted", detail: "cancelled" };
}

function toolDescription(roster: readonly ResolvedSubagent[]): string {
	const kinds = roster
		.map((entry) => `\`${entry.id}\` (${entry.name}): ${entry.description}`)
		.join(" ");
	return (
		"Send a task to a subagent that works in this same workspace and does not speak in the user's chat. " +
		"It has the coding tools (read, bash, edit, write, grep, find, ls) and the same MCP tools you do. " +
		"It cannot message teammates, schedule work, or spawn another subagent. " +
		"Its drafts and tool calls stay off this conversation; you receive one report when it finishes. " +
		`Kinds available to you: ${kinds} ` +
		"Omit `kind` for the task runner (`generic`). Pass `model` as provider/id to override the kind's model; omit it to use the kind's, or yours if the kind has none. " +
		"Use this for a bounded piece of work that would take many tool calls, or for pieces that can run at the same time. " +
		"Do not use it to talk to the user, and do not use it for something a single tool call would finish. " +
		"The subagent cannot see this conversation — put everything it needs in `prompt`."
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
			"Use subagent for work that would take many tool calls, or that can run while you do something else.",
			`kind is one of: ${subagentKindList(roster)}. Omit it for the task runner. Pass model as provider/id to override; omit it to use the kind's model, or yours.`,
			"The subagent cannot see this conversation. Put everything it needs in the prompt.",
			"Do not send the user a play-by-play of a subagent; wait for the report, then say what came of it.",
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
