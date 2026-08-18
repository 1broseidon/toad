import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Containment } from "../../shared/types";

/**
 * Whether the backend will actually stop to ask before acting.
 *
 * Toad renders permission requests, but it does not get to decide whether the
 * agent sends them. That is the backend's own configuration, and when it is set
 * to approve everything Toad's prompt simply never fires.
 *
 * This used to be pushed into the conversation as a warning, which was the
 * wrong place: it describes how the machine is configured, it never changes
 * while you are talking, and it appeared again on every session start. It is a
 * setting, so it is reported in settings.
 *
 * `known: false` for everything but Cursor, and that is the honest answer
 * rather than a gap. Each agent keeps its approval policy in its own format and
 * Toad can only read the one it knows; claiming the others ask first would be a
 * guess about the exact thing someone came here to check.
 */
const UNKNOWN: Containment = { known: false };

export function describeContainment(backendId: string): Containment {
	if (backendId !== "cursor") return UNKNOWN;

	const configPath = join(homedir(), ".cursor", "cli-config.json");
	if (!existsSync(configPath)) return UNKNOWN;

	let parsed: { approvalMode?: string; sandbox?: { mode?: string } };
	try {
		parsed = JSON.parse(readFileSync(configPath, "utf8"));
	} catch {
		return UNKNOWN;
	}

	return {
		known: true,
		asksPermission: parsed.approvalMode !== "unrestricted",
		sandboxed: parsed.sandbox?.mode !== undefined && parsed.sandbox.mode !== "disabled",
		configPath,
	};
}
