import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../paths";

/**
 * Whether Toad's own tools may ride along to an ACP backend, and why.
 *
 * `reason` is required, and used to be optional. That optionality was the bug:
 * the default deny below returned `{attach: false}` with nothing beside it, so
 * a backend nobody had tested lost every Toad tool — hop, message_teammate,
 * request_human, all of them — and the only trace was their absence. The
 * teammate's system prompt still promised them. A verdict that cannot be
 * written without a sentence cannot deny in silence.
 */
export type Verdict = { attach: boolean; reason: string };

/** Verified by scripts/verify-mcp-sidecar.ts. Anything absent is denied. */
const SHIPPED: Record<string, Verdict> = {
	cursor: { attach: true, reason: "observed to keep its own tools when Toad supplies a server" },
	"claude-acp": {
		attach: true,
		reason: "observed to keep its own tools when Toad supplies a server",
	},
	"codex-acp": {
		attach: true,
		reason: "observed to keep its own tools when Toad supplies a server",
	},
};

let verdicts: Record<string, Verdict> | undefined;

function allVerdicts(): Record<string, Verdict> {
	if (verdicts) return verdicts;
	verdicts = { ...SHIPPED };
	const file = join(ROOT, "mcp-compat.json");
	if (!existsSync(file)) return verdicts;
	try {
		const parsed = JSON.parse(readFileSync(file, "utf8")) as {
			version?: unknown;
			backends?: Record<string, unknown>;
		};
		if (parsed.version !== 1 || !parsed.backends || typeof parsed.backends !== "object") {
			return verdicts;
		}
		for (const [backendId, raw] of Object.entries(parsed.backends)) {
			if (!raw || typeof raw !== "object" || typeof (raw as Verdict).attach !== "boolean") continue;
			const value = raw as Verdict;
			verdicts[backendId] = {
				attach: value.attach,
				reason:
					typeof value.reason === "string" && value.reason.trim()
						? value.reason
						: `the machine-derived compatibility table records attach=${value.attach} for ${backendId} without saying why`,
			};
		}
	} catch {
		// A malformed machine-derived override safely degrades to the shipped deny-list.
	}
	return verdicts;
}

export function sidecarVerdict(backendId: string): Verdict {
	return (
		allVerdicts()[backendId] ?? {
			attach: false,
			reason:
				`${backendId} is not on the tested compatibility list, and the ACP spec does not say ` +
				"whether a backend merges a supplied MCP server with its own tools or replaces them — " +
				"so Toad does not risk taking the backend's own tools away. Run " +
				"scripts/verify-mcp-sidecar.ts against it to settle the question.",
		}
	);
}

export function sidecarAttachable(backendId: string): boolean {
	return sidecarVerdict(backendId).attach;
}
