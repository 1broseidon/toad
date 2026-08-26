import { join } from "node:path";
import { ensureLayout, ROOT } from "../paths";
import { loadJson, saveJson } from "./durable";

/**
 * How THIS desk interleaves the one room.
 *
 * Each desktop's own roster file orders its own teammates; a merged rail
 * needs one more fact — where the rows from different desktops sit relative
 * to each other — and that fact belongs to the desk doing the looking, not
 * to any of the desktops being looked at. So it lives here, as a plain
 * ranking of bare persona ids, applied as a stable sort over the merge.
 */

const ROSTER_FILE = join(ROOT, "roster.json");

function bareId(id: string): string {
	const slash = id.lastIndexOf("/");
	return slash === -1 ? id : id.slice(slash + 1);
}

/** Strip to bare ids, first occurrence wins, empties dropped. Never keeps a "/". */
function toBareIds(ids: Iterable<string>): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const id of ids) {
		const bare = bareId(id);
		if (!bare || seen.has(bare)) continue;
		seen.add(bare);
		out.push(bare);
	}
	return out;
}

export function rosterOrder(): string[] {
	const parsed = loadJson<{ order?: unknown }>(ROSTER_FILE).value;
	const raw = Array.isArray(parsed?.order)
		? parsed.order.filter((id): id is string => typeof id === "string")
		: [];
	return toBareIds(raw);
}

export function saveRosterOrder(ids: string[]): void {
	ensureLayout();
	saveJson(ROSTER_FILE, { order: toBareIds(ids) });
}

/** The merge in this desk's order; ids never ranked keep their relative place at the end. */
export function applyRosterOrder<T extends { id: string }>(personas: T[]): T[] {
	const rank = new Map(rosterOrder().map((id, index) => [id, index]));
	return [...personas].sort(
		(a, b) =>
			(rank.get(bareId(a.id)) ?? Number.MAX_SAFE_INTEGER) -
			(rank.get(bareId(b.id)) ?? Number.MAX_SAFE_INTEGER),
	);
}

/**
 * Merge a partial ranking into roster.json: listed ids (bare, deduped) first
 * in the given order, then previously ranked ids not listed, old relative
 * order kept. Used by reorderPersonas.
 */
export function mergeRosterRank(ids: string[]): void {
	const listed = toBareIds(ids);
	const listedSet = new Set(listed);
	const rest = rosterOrder().filter((id) => !listedSet.has(id));
	saveRosterOrder([...listed, ...rest]);
}
