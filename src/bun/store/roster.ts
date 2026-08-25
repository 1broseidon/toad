import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureLayout, ROOT } from "../paths";

/**
 * How THIS desk interleaves the one room.
 *
 * Each desktop's own roster file orders its own teammates; a merged rail
 * needs one more fact — where the rows from different desktops sit relative
 * to each other — and that fact belongs to the desk doing the looking, not
 * to any of the desktops being looked at. So it lives here, as a plain
 * ranking of qualified ids, applied as a stable sort over the merge.
 */

const ROSTER_FILE = join(ROOT, "roster.json");

export function rosterOrder(): string[] {
	try {
		if (!existsSync(ROSTER_FILE)) return [];
		const parsed = JSON.parse(readFileSync(ROSTER_FILE, "utf8")) as { order?: unknown };
		return Array.isArray(parsed.order)
			? parsed.order.filter((id): id is string => typeof id === "string")
			: [];
	} catch {
		return [];
	}
}

export function saveRosterOrder(ids: string[]): void {
	ensureLayout();
	writeFileSync(ROSTER_FILE, `${JSON.stringify({ order: ids }, null, 2)}\n`, "utf8");
}

/** The merge in this desk's order; ids never ranked keep their relative place at the end. */
export function applyRosterOrder<T extends { id: string }>(personas: T[]): T[] {
	const rank = new Map(rosterOrder().map((id, index) => [id, index]));
	return [...personas].sort(
		(a, b) =>
			(rank.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.id) ?? Number.MAX_SAFE_INTEGER),
	);
}
