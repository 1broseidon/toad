/**
 * The instance jar: every desktop this phone has been linked to.
 *
 * A phone is not tied to one Toad the way a browser tab is — it goes home
 * from the office and the desktop it was talking to is gone, not broken. So
 * the link is a row rather than a single token: a desktop's own
 * `instanceId` names it, the origin is where it was last seen, and the
 * token is this device's key to it. A desktop that moves keeps its row and
 * changes its address; a desktop that revokes this device keeps its row and
 * goes grey.
 *
 * Stored through Capacitor's Preferences where there is a native shell to
 * ask (it survives a WebView clearing its own storage) and localStorage
 * everywhere else, including a desktop browser running `?shell=native`.
 */

const JAR_KEY = "toad-instances";

export type LinkedInstance = {
	/** The desktop's own id, stable across its address changing. */
	id: string;
	/** Its host name, as it introduced itself. Editable later. */
	name: string;
	origin: string;
	token: string;
	deviceId: string;
	pairedAt: number;
	lastSeenAt: number;
	lastKnownVersion: string | null;
	state: "linked" | "unlinked";
	/**
	 * A plane member's row: the phone's own key authenticates each connection
	 * by challenge, so `token` and `deviceId` stay empty. Absent means the
	 * legacy per-desktop pairing token.
	 */
	auth?: "node";
	/** The room this desk belongs to. Absent on legacy rows, which are a
	 * direct link to one desk rather than a seat in anything. */
	roomId?: string;
	roomName?: string;
};

export type InstanceJar = {
	version: 1;
	activeId: string | null;
	instances: LinkedInstance[];
};

/** What a first launch reads, and what a broken store falls back to. */
export const EMPTY_JAR: InstanceJar = { version: 1, activeId: null, instances: [] };

/** The fields a fresh pairing settles; the rest of the row is bookkeeping. */
export type PairedInstance = {
	id: string;
	name: string;
	origin: string;
	token: string;
	deviceId: string;
	auth?: "node";
};

type KeyStore = {
	read(key: string): Promise<string | null>;
	write(key: string, value: string): Promise<void>;
};

const webStore: KeyStore = {
	async read(key) {
		try {
			return localStorage.getItem(key);
		} catch {
			return null;
		}
	},
	async write(key, value) {
		try {
			localStorage.setItem(key, value);
		} catch {}
	},
};

/**
 * Preferences when the plugin is there, localStorage when it is not.
 *
 * Loaded on demand rather than imported: the same bundle serves the browser,
 * where there is no bridge behind the plugin and nothing for it to do.
 */
async function store(): Promise<KeyStore> {
	if (typeof (window as { Capacitor?: unknown }).Capacitor === "undefined") return webStore;
	try {
		const { Preferences } = await import("@capacitor/preferences");
		return {
			async read(key) {
				const { value } = await Preferences.get({ key });
				return value ?? null;
			},
			async write(key, value) {
				await Preferences.set({ key, value });
			},
		};
	} catch {
		return webStore;
	}
}

function isRow(value: unknown): value is LinkedInstance {
	const row = value as Partial<LinkedInstance> | null;
	return Boolean(row && typeof row.id === "string" && typeof row.token === "string" && typeof row.origin === "string");
}

export async function loadJar(): Promise<InstanceJar> {
	const raw = await (await store()).read(JAR_KEY);
	if (!raw) return EMPTY_JAR;
	try {
		const parsed = JSON.parse(raw) as Partial<InstanceJar>;
		const instances = Array.isArray(parsed.instances) ? parsed.instances.filter(isRow) : [];
		const activeId = typeof parsed.activeId === "string" ? parsed.activeId : null;
		return {
			version: 1,
			// An active id whose row is gone is not a selection, it is a dangling
			// pointer — and it would show the app an instance it cannot reach.
			activeId: instances.some((row) => row.id === activeId) ? activeId : null,
			instances,
		};
	} catch {
		return EMPTY_JAR;
	}
}

export async function saveJar(jar: InstanceJar): Promise<void> {
	await (await store()).write(JAR_KEY, JSON.stringify(jar));
}

export function listInstances(jar: InstanceJar): LinkedInstance[] {
	return jar.instances;
}

export function activeOf(jar: InstanceJar): LinkedInstance | null {
	return jar.instances.find((row) => row.id === jar.activeId) ?? null;
}

export function setActive(jar: InstanceJar, id: string | null): InstanceJar {
	if (jar.activeId === id) return jar;
	if (id !== null && !jar.instances.some((row) => row.id === id)) return jar;
	return { ...jar, activeId: id };
}

/**
 * A finished pairing, folded in.
 *
 * The same desktop pairing again is the DHCP case: it kept its id and moved,
 * so the row is updated where it stands rather than joined by a second one
 * with the same name.
 */
export function upsertFromPair(jar: InstanceJar, paired: PairedInstance): InstanceJar {
	const now = Date.now();
	if (jar.instances.some((row) => row.id === paired.id)) {
		return {
			...jar,
			instances: jar.instances.map((row) =>
				row.id === paired.id
					? {
							...row,
							name: paired.name || row.name,
							origin: paired.origin,
							token: paired.token,
							deviceId: paired.deviceId,
							lastSeenAt: now,
							state: "linked",
						}
					: row,
			),
		};
	}
	return {
		...jar,
		instances: [
			...jar.instances,
			{
				...paired,
				pairedAt: now,
				lastSeenAt: now,
				lastKnownVersion: null,
				state: "linked",
			},
		],
	};
}

/**
 * A membership's whole room, folded in at once.
 *
 * Every desk the grant names becomes a node-auth row — the join and each
 * session hand the list back, so a grant widened on a desktop appears here
 * on the next connect without another scan. A legacy row for the same desk
 * upgrades in place, dropping the bearer token it no longer needs. A desk
 * with no reachable door keeps its old address if it had one, and is skipped
 * if it never did: a row with nowhere to knock is a name, not a desktop.
 */
export function foldRoom(
	jar: InstanceJar,
	desktops: Array<{ nodeId: string; name: string; origin: string | null }>,
	activateNodeId?: string | null,
	room?: { id: string; name: string },
): InstanceJar {
	const now = Date.now();
	const instances = [...jar.instances];
	for (const desk of desktops) {
		const index = instances.findIndex((row) => row.id === desk.nodeId);
		if (index === -1) {
			if (!desk.origin) continue;
			instances.push({
				id: desk.nodeId,
				name: desk.name,
				origin: desk.origin,
				token: "",
				deviceId: "",
				pairedAt: now,
				lastSeenAt: now,
				lastKnownVersion: null,
				state: "linked",
				auth: "node",
				...(room ? { roomId: room.id, roomName: room.name } : {}),
			});
			continue;
		}
		const row = instances[index]!;
		instances[index] = {
			...row,
			name: desk.name || row.name,
			origin: desk.origin ?? row.origin,
			token: "",
			deviceId: "",
			lastSeenAt: now,
			state: "linked",
			auth: "node",
			...(room ? { roomId: room.id, roomName: room.name } : {}),
		};
	}
	const activeId =
		activateNodeId && instances.some((row) => row.id === activateNodeId)
			? activateNodeId
			: jar.activeId;
	return { ...jar, activeId, instances };
}

/** One entry in the rooms list: a membership, or a legacy direct link. */
export type RoomEntry = {
	/** The room's id, or `direct:<deskId>` for a legacy row standing alone. */
	key: string;
	name: string;
	/** Legacy single-desk link rather than a membership. */
	direct: boolean;
	desks: LinkedInstance[];
};

/**
 * The jar as the user should read it: rooms, not machines.
 *
 * Member rows group under their room; each legacy row stands alone as a
 * direct link, named after its desk — honest about what it is, and the
 * whole category leaves with legacy support.
 */
export function roomsOf(jar: InstanceJar): RoomEntry[] {
	const rooms = new Map<string, RoomEntry>();
	for (const row of jar.instances) {
		const key = row.auth === "node" && row.roomId ? row.roomId : `direct:${row.id}`;
		const entry = rooms.get(key);
		if (entry) {
			entry.desks.push(row);
			continue;
		}
		rooms.set(key, {
			key,
			name: row.auth === "node" && row.roomId ? (row.roomName ?? "Toad Room") : row.name,
			direct: !(row.auth === "node" && row.roomId),
			desks: [row],
		});
	}
	return [...rooms.values()];
}

/** The room entry the active desk sits in, if any. */
export function activeRoomOf(jar: InstanceJar): RoomEntry | null {
	if (!jar.activeId) return null;
	return roomsOf(jar).find((room) => room.desks.some((desk) => desk.id === jar.activeId)) ?? null;
}

/** The desk a room switch should land on: linked, most recently seen. */
export function bestDeskOf(room: RoomEntry): LinkedInstance | null {
	const linked = room.desks.filter((desk) => desk.state === "linked");
	linked.sort((a, b) => b.lastSeenAt - a.lastSeenAt);
	return linked[0] ?? room.desks[0] ?? null;
}

/**
 * Leaving the room: every member row goes at once.
 *
 * A member phone's desktop list is a projection of its grant, so forgetting
 * one desk locally is a fight with the next connect, which would fold it
 * straight back in. The phone-side act is leaving whole; which desks the
 * membership may see is the grant, edited on the desk that owns it. The
 * membership itself survives on the desks — scanning any granted desk's
 * code brings the room back under the same identity.
 */
export function leaveRoom(jar: InstanceJar): { jar: InstanceJar; removed: string[] } {
	const removed = jar.instances.filter((row) => row.auth === "node").map((row) => row.id);
	if (removed.length === 0) return { jar, removed };
	const instances = jar.instances.filter((row) => row.auth !== "node");
	return {
		jar: {
			...jar,
			activeId: removed.includes(jar.activeId ?? "") ? null : jar.activeId,
			instances,
		},
		removed,
	};
}

/** The row goes. Revoking on the desktop is a separate act, and may fail. */
export function forget(jar: InstanceJar, id: string): InstanceJar {
	const instances = jar.instances.filter((row) => row.id !== id);
	if (instances.length === jar.instances.length) return jar;
	return {
		...jar,
		// Forgetting the one you were on is a return to the list, not a
		// silent hop onto whichever row happens to be first.
		activeId: jar.activeId === id ? null : jar.activeId,
		instances,
	};
}

/**
 * The desktop no longer accepts this device's token.
 *
 * The row stays: it is the record of which desktop this was, and linking
 * again should land on it rather than mint a duplicate.
 */
export function markUnlinked(jar: InstanceJar, id: string): InstanceJar {
	return {
		...jar,
		instances: jar.instances.map((row) => (row.id === id ? { ...row, state: "unlinked" } : row)),
	};
}

/** Answered, and running this version — what the inactive rows report later. */
export function markSeen(jar: InstanceJar, id: string, version: string | null): InstanceJar {
	return {
		...jar,
		instances: jar.instances.map((row) =>
			row.id === id
				? { ...row, lastSeenAt: Date.now(), lastKnownVersion: version ?? row.lastKnownVersion }
				: row,
		),
	};
}
