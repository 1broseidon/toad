import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, ensureLayout } from "../paths";

/**
 * Who a team's round-robin picked, and when.
 *
 * Not an index into a member list — members come and go, and an index into a
 * list that changed under it hands one teammate every task. Least-recently-
 * picked is the rotation that survives everything: a restart (the file
 * remembers), a member removed mid-rotation (their entry just stops
 * mattering), a member added (never picked, so they are up next). Keyed by
 * the team label lower-cased, since that is how targets resolve.
 */

type Picks = Record<string, Record<string, number>>;

const FILE = () => join(ROOT, "teams.json");

function read(): Picks {
	try {
		if (!existsSync(FILE())) return {};
		return JSON.parse(readFileSync(FILE(), "utf8")) as Picks;
	} catch {
		return {};
	}
}

export function picksFor(team: string): Record<string, number> {
	return read()[team.toLowerCase()] ?? {};
}

export function notePick(team: string, personaId: string): void {
	ensureLayout();
	const picks = read();
	const label = team.toLowerCase();
	picks[label] = { ...picks[label], [personaId]: Date.now() };
	try {
		writeFileSync(FILE(), JSON.stringify(picks, null, "\t"));
	} catch {
		/* A rotation that forgets one pick is still a rotation. */
	}
}
