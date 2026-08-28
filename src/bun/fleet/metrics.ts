export type MeshEvent = string;

export type MeshKind =
	| "send"
	| "webBroadcast"
	| "peerBroadcast"
	| "nodePeerBroadcast"
	| "nodeLinkBroadcast"
	| "onPeerPush"
	| "onPeerPushDrop"
	| "mergePeerRecords"
	| "wireCallLocal"
	| "syncShip"
	| "syncApply"
	| "syncDrop"
	| "meshIntroduction"
	| "replicaShip"
	| "replicaApply"
	| "replicaRefuse"
	| "replicaDrop";

const MAX_KEYS = 256;

let startedAt = Date.now();
const totals = new Map<string, number>();
const bytes = new Map<string, number>();

function keyOf(kind: MeshKind, name: MeshEvent): string {
	return `${kind}:${name}`;
}

function bump(map: Map<string, number>, key: string, n: number): boolean {
	const current = map.get(key);
	if (current !== undefined) {
		map.set(key, current + n);
		return true;
	}
	if (map.size >= MAX_KEYS) return false;
	map.set(key, n);
	return true;
}

export function meshCount(
	kind: MeshKind,
	name: MeshEvent,
	extra?: { bytes?: number; nodeId?: string },
): void {
	const key = keyOf(kind, name);
	if (!bump(totals, key, 1)) return;
	const n = extra?.bytes;
	if (n !== undefined) bump(bytes, key, n);
}

export function meshSnapshot(): {
	startedAt: number;
	totals: Record<string, number>;
	bytes: Record<string, number>;
} {
	return {
		startedAt,
		totals: Object.fromEntries(totals),
		bytes: Object.fromEntries(bytes),
	};
}

export function meshReset(): void {
	totals.clear();
	bytes.clear();
	startedAt = Date.now();
}
