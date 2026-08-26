import { beforeEach, describe, expect, test } from "bun:test";
import type { Envelope, SyncOp } from "../node/envelope";

// The throwaway root comes from test/preload.ts. Setting TOAD_DATA_DIR here
// would be far too late: these imports resolve it.
const records = await import("../store/records");
const metrics = await import("./metrics");
const sync = await import("./sync");

const LOCAL = records.localNodeId();

let published = 0;
const seen: string[] = [];

sync.initSync({
	publishRoster: () => {
		published += 1;
	},
	markSeen: (nodeId) => {
		seen.push(nodeId);
	},
});

/** A link that only remembers what sync asked it to send. */
type FakeLink = {
	sent: Envelope[];
	envelope(env: Envelope): boolean;
};

function fakeLink(onSend?: (env: Envelope) => void): FakeLink {
	const sent: Envelope[] = [];
	return {
		sent,
		envelope(env) {
			sent.push(env);
			onSend?.(env);
			return true;
		},
	};
}

/** The op batches a link was handed, in send order. */
function batches(link: FakeLink): SyncOp[][] {
	const frames: SyncOp[][] = [];
	for (const env of link.sent) if (env.kind === "sync.ops") frames.push(env.payload.ops);
	return frames;
}

function hellos(link: FakeLink): number[] {
	const sent: number[] = [];
	for (const env of link.sent) if (env.kind === "sync.hello") sent.push(env.payload.cursor);
	return sent;
}

function hello(src: string, cursor: number, dst = LOCAL) {
	return { v: 1, src, dst, kind: "sync.hello", payload: { cursor } };
}

function opsFrame(src: string, ops: SyncOp[], dst = LOCAL) {
	return { v: 1, src, dst, kind: "sync.ops", payload: { ops } };
}

function op(owner: string, id: string, version: number, seq: number): SyncOp {
	return {
		kind: "persona",
		id,
		ownerNode: owner,
		ownerEpoch: 1,
		version,
		op: "put",
		payload: { name: `${id} v${version}` },
		at: Date.now(),
		seq,
	};
}

/** This node's whole first-hand history, read straight from the store. */
function ownOps(): SyncOp[] {
	return records.oplogAfter(LOCAL, 0);
}

/** Every syncDrop counter, summed — the tests assert deltas, never totals. */
function drops(): number {
	let total = 0;
	for (const [key, value] of Object.entries(metrics.meshSnapshot().totals)) {
		if (key.startsWith("syncDrop:")) total += value;
	}
	return total;
}

/**
 * Grows this node's oplog to at least `target` rows.
 *
 * Versions of one persona rather than many personas: the same number of oplog
 * rows for one resource row, so the JSON snapshot each write exports stays
 * small.
 */
function buildHistory(target: number): void {
	let count = ownOps().length;
	while (count < target) {
		records.putLocal("persona", "sync-history", { replicated: { name: `v${count}` } });
		count += 1;
	}
}

// Sessions live for the length of a link, and these tests share one module.
beforeEach(() => {
	for (const peer of sync.syncSnapshot()) sync.syncLinkDown(peer.nodeId);
	published = 0;
	seen.length = 0;
});

describe("shipping first-hand ops", () => {
	test("a hello at cursor 0 drains the whole history in ascending batches of 200", () => {
		buildHistory(205);
		const history = ownOps();
		expect(history.length).toBeGreaterThan(200);

		const link = fakeLink();
		sync.syncLinkUp("peer-full", link);
		expect(hellos(link)).toEqual([0]);
		sync.receiveEnvelope("peer-full", hello("peer-full", 0));

		const frames = batches(link);
		expect(frames.length).toBe(Math.ceil(history.length / 200));
		expect(frames[0]?.length).toBe(200);
		for (const frame of frames) expect(frame.length).toBeLessThanOrEqual(200);

		const shipped = frames.flat();
		expect(shipped.map((one) => one.seq)).toEqual(history.map((one) => one.seq));
		for (const [index, one] of shipped.entries()) {
			if (index > 0) expect(one.seq).toBeGreaterThan(shipped[index - 1]?.seq ?? 0);
			expect(one.ownerNode).toBe(LOCAL);
		}
		expect(sync.syncSnapshot()).toContainEqual({
			nodeId: "peer-full",
			applied: 0,
			shipped: history[history.length - 1]?.seq ?? 0,
			live: true,
		});
	});

	test("a hello above our highest seq resets to 0 and re-ships everything", () => {
		buildHistory(3);
		const history = ownOps();
		const last = history[history.length - 1]?.seq ?? 0;

		const link = fakeLink();
		sync.syncLinkUp("peer-reset", link);
		sync.receiveEnvelope("peer-reset", hello("peer-reset", last + 500));

		expect(batches(link).flat().map((one) => one.seq)).toEqual(history.map((one) => one.seq));
	});

	test("a hello at our highest seq ships nothing", () => {
		buildHistory(3);
		const history = ownOps();

		const link = fakeLink();
		sync.syncLinkUp("peer-caught-up", link);
		sync.receiveEnvelope(
			"peer-caught-up",
			hello("peer-caught-up", history[history.length - 1]?.seq ?? 0),
		);

		expect(batches(link)).toEqual([]);
	});

	test("a local write rings the doorbell for a live peer; an applied remote op does not", () => {
		const link = fakeLink();
		sync.syncLinkUp("peer-live", link);
		sync.receiveEnvelope("peer-live", hello("peer-live", 0));
		const before = batches(link).length;

		records.putLocal("persona", "sync-doorbell", { replicated: { name: "doorbell" } });
		const frames = batches(link);
		expect(frames.length).toBe(before + 1);
		const shipped = frames[frames.length - 1] ?? [];
		expect(shipped.length).toBe(1);
		expect(shipped[0]?.id).toBe("sync-doorbell");

		// A remote op is somebody else's first-hand history: applying it must
		// not put anything on the wire.
		expect(records.applyRemoteOps([op("owner-quiet", "quiet", 1, 1)]).applied).toBe(true);
		expect(batches(link).length).toBe(before + 1);
	});

	test("a doorbell during a drain re-runs it without reordering batches", () => {
		buildHistory(205);
		let rung = false;
		const link = fakeLink((env) => {
			if (env.kind !== "sync.ops" || rung) return;
			rung = true;
			// Mid-drain commit: the doorbell has to wait for the walk in flight.
			records.putLocal("persona", "sync-midflight", { replicated: { name: "midflight" } });
		});

		sync.syncLinkUp("peer-midflight", link);
		sync.receiveEnvelope("peer-midflight", hello("peer-midflight", 0));

		expect(rung).toBe(true);
		const shipped = batches(link).flat();
		const seqs = shipped.map((one) => one.seq);
		expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
		expect(new Set(seqs).size).toBe(seqs.length);
		expect(seqs).toEqual(ownOps().map((one) => one.seq));
		expect(shipped[shipped.length - 1]?.id).toBe("sync-midflight");
	});

	test("a link that will not take a frame stops the drain", () => {
		buildHistory(205);
		const link = { sent: [] as Envelope[], envelope: () => false };
		sync.syncLinkUp("peer-down", link);
		sync.receiveEnvelope("peer-down", hello("peer-down", 0));
		expect(sync.syncSnapshot().find((one) => one.nodeId === "peer-down")?.shipped).toBe(0);
	});
});

describe("applying a peer's ops", () => {
	test("a valid batch applies, advances the durable cursor, and publishes", () => {
		const owner = "owner-applied";
		const link = fakeLink();
		sync.syncLinkUp(owner, link);
		expect(hellos(link)).toEqual([0]);

		sync.receiveEnvelope(
			owner,
			opsFrame(owner, [op(owner, "applied-a", 1, 7), op(owner, "applied-b", 1, 9)]),
		);

		const record = records.getRecord("persona", "applied-a");
		expect(record?.ownerNode).toBe(owner);
		expect(record?.replicated.name).toBe("applied-a v1");
		expect(records.appliedCursor(owner)).toBe(9);
		expect(published).toBe(1);
		expect(seen).toEqual([owner, owner]);
		expect(sync.syncSnapshot()).toContainEqual({
			nodeId: owner,
			applied: 9,
			shipped: null,
			live: false,
		});
	});

	test("a replayed batch keeps the cursor and publishes nothing new", () => {
		const owner = "owner-replay";
		const link = fakeLink();
		sync.syncLinkUp(owner, link);
		const frame = opsFrame(owner, [op(owner, "replay-a", 1, 4)]);

		sync.receiveEnvelope(owner, frame);
		expect(published).toBe(1);
		published = 0;

		sync.receiveEnvelope(owner, frame);
		expect(records.appliedCursor(owner)).toBe(4);
		expect(published).toBe(0);
	});

	test("a stale batch falls back per op, skips the stale one, and still advances", () => {
		const owner = "owner-stale";
		const link = fakeLink();
		sync.syncLinkUp(owner, link);
		// Version 3 lands first, so a later frame carrying version 2 is history
		// this node has already moved past — and version 2 is not in its oplog.
		expect(records.applyRemoteOps([op(owner, "stale-a", 3, 10)]).applied).toBe(true);
		records.setAppliedCursor(owner, 10);

		const before = drops();
		sync.receiveEnvelope(
			owner,
			opsFrame(owner, [op(owner, "stale-a", 2, 11), op(owner, "stale-a", 4, 12)]),
		);

		expect(drops()).toBe(before + 1);
		const record = records.getRecord("persona", "stale-a");
		expect(record?.version).toBe(4);
		expect(records.appliedCursor(owner)).toBe(12);
		expect(published).toBe(1);
	});
});

describe("dropping what it cannot trust", () => {
	function refuses(peer: string, env: unknown): void {
		const link = fakeLink();
		sync.syncLinkUp(peer, link);
		const before = drops();

		sync.receiveEnvelope(peer, env);

		expect(drops()).toBe(before + 1);
		expect(records.appliedCursor(peer)).toBe(0);
		expect(records.getRecord("persona", `${peer}-record`)).toBeUndefined();
		expect(batches(link)).toEqual([]);
		expect(published).toBe(0);
		sync.syncLinkDown(peer);
	}

	test("a batch from the wrong sender is dropped", () => {
		const peer = "drop-src";
		refuses(peer, opsFrame("impostor", [op("impostor", `${peer}-record`, 1, 1)]));
	});

	test("a batch addressed to another node is dropped", () => {
		const peer = "drop-dst";
		refuses(peer, opsFrame(peer, [op(peer, `${peer}-record`, 1, 1)], "somebody-else"));
	});

	test("a relayed third node's op is dropped", () => {
		const peer = "drop-relay";
		refuses(peer, opsFrame(peer, [op("third-node", `${peer}-record`, 1, 1)]));
	});

	test("a hello from the wrong sender ships nothing", () => {
		const peer = "drop-hello";
		buildHistory(3);
		refuses(peer, hello("impostor", 0));
	});

	test("malformed envelopes are dropped", () => {
		const peer = "drop-shape";
		const good = op(peer, `${peer}-record`, 1, 1);
		refuses(peer, { v: 2, src: peer, dst: LOCAL, kind: "sync.ops", payload: { ops: [good] } });
		refuses(peer, opsFrame(peer, []));
		refuses(peer, { v: 1, src: peer, dst: LOCAL, kind: "sync.bye", payload: {} });
		refuses(peer, hello(peer, -1));
		refuses(peer, hello(peer, 1.5));
		refuses(peer, opsFrame(peer, [{ ...good, version: 0 }]));
		refuses(peer, opsFrame(peer, [{ ...good, seq: 0 }]));
		refuses(peer, opsFrame(peer, [{ ...good, payload: null as never }]));
		refuses(peer, opsFrame(peer, [{ ...good, kind: "other" as never }]));
		refuses(peer, null);
	});

	test("an envelope arriving with no session is dropped", () => {
		const before = drops();
		sync.receiveEnvelope("stranger", hello("stranger", 0));
		expect(drops()).toBe(before + 1);
	});

	test("a dropped link forgets the ship session but not the cursor", () => {
		const owner = "owner-forget";
		const link = fakeLink();
		sync.syncLinkUp(owner, link);
		sync.receiveEnvelope(owner, opsFrame(owner, [op(owner, "forget-a", 1, 3)]));
		sync.syncLinkDown(owner);

		expect(sync.syncSnapshot().some((one) => one.nodeId === owner)).toBe(false);
		expect(records.appliedCursor(owner)).toBe(3);
	});
});
