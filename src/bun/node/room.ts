import { randomBytes } from "node:crypto";
import type { HarnessChoice } from "../../shared/types";
import {
	getRecord,
	listRecords,
	localNodeId,
	putLocal,
	tombstoneLocal,
	type ResourceRecord,
} from "../store/records";

/**
 * The room: the named thing everything joins.
 *
 * To the user there is one system — "George's Agents", not a mesh of
 * computers. The name is a replicated `room` record like any other, owned
 * by the desk that founded it, and every member learns it through the same
 * first-hand sync personas ride.
 *
 * Founding is lazy and naming is the founding. A fresh setup names its room
 * where the concept first matters — showing an invite; anything that needs
 * a room before a person has named one (a phone join against a desk that
 * never opened that pane) founds it as "Toad Room", renameable later.
 *
 * Two desks that each founded a room and then meet hold two records. The
 * room *is* the earliest-created one — a pure function of the replicated
 * set, so every member picks the same winner without a vote — and a desk
 * whose own record lost retires it with a tombstone the next time it
 * founds-or-fetches. No migration, no prompt; convergence is the rule.
 */

export const DEFAULT_ROOM_NAME = "Toad Room";

export type RoomInfo = {
	id: string;
	name: string;
	foundedBy: string;
	createdAt: number;
	/** Whether this desk owns the record and may rename it. */
	editable: boolean;
	/** The room's fallback harness — the matching ladder's last rung. */
	defaultHarness?: HarnessChoice;
};

/** A stored harness choice, or nothing when missing or malformed. */
function normalizeHarness(value: unknown): HarnessChoice | undefined {
	const candidate = value as Partial<HarnessChoice> | undefined;
	if (typeof candidate?.backendId !== "string" || candidate.backendId.length === 0) {
		return undefined;
	}
	return {
		backendId: candidate.backendId,
		...(typeof candidate.modelId === "string" && candidate.modelId.length > 0
			? { modelId: candidate.modelId }
			: {}),
	};
}

function roomOf(record: ResourceRecord): RoomInfo | null {
	const name = record.replicated.name;
	if (typeof name !== "string" || name.length === 0) return null;
	const defaultHarness = normalizeHarness(record.replicated.defaultHarness);
	return {
		id: record.id,
		name,
		foundedBy: record.ownerNode,
		createdAt:
			typeof record.replicated.createdAt === "number"
				? record.replicated.createdAt
				: record.updatedAt,
		editable: record.ownerNode === localNodeId(),
		...(defaultHarness ? { defaultHarness } : {}),
	};
}

/** Every live room record, parsed. Normally one; two only mid-convergence. */
function liveRooms(): RoomInfo[] {
	return listRecords("room")
		.map(roomOf)
		.filter((room): room is RoomInfo => room !== null);
}

/**
 * The room this desk is in, or null when nothing has founded one yet.
 * Deterministic across members: earliest founding wins, id breaks ties.
 */
export function currentRoom(): RoomInfo | null {
	const rooms = liveRooms();
	if (rooms.length === 0) return null;
	rooms.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
	return rooms[0] ?? null;
}

/**
 * The room, founding it under `name` when none exists — and retiring this
 * desk's own losing record when convergence picked another founder's.
 */
export function ensureRoom(name = DEFAULT_ROOM_NAME): RoomInfo {
	const winner = currentRoom();
	if (winner) {
		for (const room of liveRooms()) {
			if (room.id !== winner.id && room.editable) tombstoneLocal("room", room.id);
		}
		return winner;
	}
	const id = randomBytes(8).toString("hex");
	const record = putLocal("room", id, {
		replicated: { name: name.trim().slice(0, 80) || DEFAULT_ROOM_NAME, createdAt: Date.now() },
	});
	const founded = roomOf(record);
	if (!founded) throw new Error("The room record did not read back");
	return founded;
}

/**
 * Renames the room — founding it under that name when none exists, which is
 * what a fresh setup's "name your room" ask resolves to. Rename itself is
 * the founder desk's act; records have one writer.
 */
export function renameRoom(name: string): RoomInfo {
	const clean = name.trim().slice(0, 80);
	if (!clean) throw new Error("A room needs a name");
	const room = currentRoom();
	if (!room) return ensureRoom(clean);
	if (!room.editable) {
		throw new Error(`Only ${room.foundedBy} can rename this room`);
	}
	const current = getRecord("room", room.id);
	putLocal("room", room.id, {
		replicated: { ...(current?.replicated ?? {}), name: clean },
	});
	const renamed = currentRoom();
	if (!renamed) throw new Error("The room record did not read back");
	return renamed;
}

/**
 * Sets or clears the room's fallback harness — room policy, so it rides the
 * room record and replicates like the name. Founding the room if none exists
 * mirrors `renameRoom`: configuring a default is as good a first act as naming.
 * Only the founder desk may write it; records have one writer.
 */
export function setRoomDefaultHarness(choice: HarnessChoice | null): RoomInfo {
	const normalized = choice === null ? undefined : normalizeHarness(choice);
	if (choice !== null && !normalized) throw new Error("A default harness needs a backend id");
	const room = ensureRoom();
	if (!room.editable) {
		throw new Error(`Only ${room.foundedBy} can set this room's default harness`);
	}
	const current = getRecord("room", room.id);
	const replicated = { ...(current?.replicated ?? {}) };
	if (normalized) replicated.defaultHarness = normalized;
	else delete replicated.defaultHarness;
	putLocal("room", room.id, { replicated });
	const updated = currentRoom();
	if (!updated) throw new Error("The room record did not read back");
	return updated;
}
