import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../paths";

export type Verdict = { attach: boolean; reason?: string };

/** Verified by scripts/verify-mcp-sidecar.ts. Anything absent is denied. */
const SHIPPED: Record<string, Verdict> = {
	cursor: { attach: true },
	"claude-acp": { attach: true },
	"codex-acp": { attach: true },
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
				...(typeof value.reason === "string" ? { reason: value.reason } : {}),
			};
		}
	} catch {
		// A malformed machine-derived override safely degrades to the shipped deny-list.
	}
	return verdicts;
}

export function sidecarVerdict(backendId: string): Verdict {
	return allVerdicts()[backendId] ?? { attach: false };
}

export function sidecarAttachable(backendId: string): boolean {
	return sidecarVerdict(backendId).attach;
}
