import { expect, test } from "bun:test";
import {
	activeRoomOf,
	forget,
	type InstanceJar,
	leaveRoom,
	type LinkedInstance,
	roomsOf,
} from "./store";

/**
 * The jar's room arithmetic.
 *
 * A phone holds many memberships at once, which is the whole reason rooms
 * exist as a noun — so the acts that remove rows have to be able to name
 * which room they mean. Until 2026-08-27 `leaveRoom` took no key and dropped
 * every member row in the jar: leaving the work room also left the personal
 * one, silently, with no way back but a re-scan. These pin the scoping down.
 */

let clock = 1_700_000_000_000;

/** A member row in a room, at a distinct `pairedAt` so ordering is readable. */
function member(id: string, roomId: string, roomName: string): LinkedInstance {
	clock += 1_000;
	return {
		id,
		name: id,
		origin: `http://${id}:4680`,
		token: "",
		deviceId: "",
		pairedAt: clock,
		lastSeenAt: clock,
		lastKnownVersion: null,
		state: "linked",
		auth: "node",
		roomId,
		roomName,
	};
}

/** A pre-room pairing: one desk, a bearer token, no room behind it. */
function direct(id: string): LinkedInstance {
	clock += 1_000;
	return {
		id,
		name: id,
		origin: `http://${id}:4680`,
		token: "tok",
		deviceId: "dev",
		pairedAt: clock,
		lastSeenAt: clock,
		lastKnownVersion: null,
		state: "linked",
	};
}

function jarOf(activeId: string | null, ...instances: LinkedInstance[]): InstanceJar {
	return { version: 1, activeId, instances };
}

test("leaving one room keeps the other, and the active desk with it", () => {
	const jar = jarOf(
		"work-a",
		member("home-a", "room-home", "Home"),
		member("work-a", "room-work", "Work"),
		member("work-b", "room-work", "Work"),
	);

	const { jar: next, removed } = leaveRoom(jar, "room-home");

	expect(removed).toEqual(["home-a"]);
	expect(next.instances.map((row) => row.id)).toEqual(["work-a", "work-b"]);
	// The wire was in Work and Work was not the room being left, so nothing
	// about the connection changes — no reconnect, no trip through the list.
	expect(next.activeId).toBe("work-a");
	expect(roomsOf(next).map((room) => room.key)).toEqual(["room-work"]);
});

test("leaving the room you were riding clears the active desk, and only then", () => {
	const jar = jarOf(
		"work-a",
		member("home-a", "room-home", "Home"),
		member("work-a", "room-work", "Work"),
	);

	const left = leaveRoom(jar, "room-work");
	expect(left.removed).toEqual(["work-a"]);
	// A pointer into the room that just went is dangling, not a selection.
	expect(left.jar.activeId).toBeNull();
	expect(left.jar.instances.map((row) => row.id)).toEqual(["home-a"]);
	expect(activeRoomOf(left.jar)).toBeNull();
});

test("a direct link's key leaves every membership alone", () => {
	const jar = jarOf("home-a", member("home-a", "room-home", "Home"), direct("old-desk"));
	const rooms = roomsOf(jar);
	const legacy = rooms.find((room) => room.direct);
	expect(legacy?.key).toBe("direct:old-desk");

	// A legacy row is forgotten, not left: it has no grant to fold it back in.
	// Handing its key to leaveRoom must be a no-op rather than a wildcard that
	// takes the memberships with it.
	const { jar: next, removed } = leaveRoom(jar, legacy!.key);
	expect(removed).toEqual([]);
	expect(next).toBe(jar);
	expect(next.instances).toHaveLength(2);

	// The act that does remove it touches nothing else.
	const dropped = forget(jar, "old-desk");
	expect(dropped.instances.map((row) => row.id)).toEqual(["home-a"]);
	expect(dropped.activeId).toBe("home-a");
});

test("an unknown room key changes nothing at all", () => {
	const jar = jarOf("home-a", member("home-a", "room-home", "Home"));
	const { jar: next, removed } = leaveRoom(jar, "room-that-was-already-left");
	expect(removed).toEqual([]);
	expect(next).toBe(jar);
});

test("a member row with no room id is never swept up by a leave", () => {
	// Rows folded in before the room field existed group as direct links; they
	// are the shape most at risk from a match that keys on `auth` alone.
	const orphan: LinkedInstance = { ...member("orphan", "x", "x"), roomId: undefined, roomName: undefined };
	const jar = jarOf("home-a", member("home-a", "room-home", "Home"), orphan);

	expect(leaveRoom(jar, "room-home").jar.instances.map((row) => row.id)).toEqual(["orphan"]);
	expect(leaveRoom(jar, "direct:orphan").removed).toEqual([]);
});
