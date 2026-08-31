/**
 * A teammate-to-teammate thread's ticks, driven through the real main process
 * on a scratch data directory.
 *
 * - a message entering a thread is written `sent`, and the file on disk says so
 * - it becomes `read` the moment the recipient's session shows any sign of a
 *   turn, and the update folds by id rather than duplicating the bubble
 * - an error before the model ran does not read it: a backend that died with
 *   the prompt still in its throat leaves one tick, which is the truth
 * - the ticks are decided by event kind alone — the same five texts, including
 *   the words a model might write to fake one, tick identically
 * - the reply's second tick comes from the desk that asked, over the real peer
 *   RPC (`threadRead`), authenticated as a real linked desktop, and lands on
 *   the thread the two participants name — never on one named by the caller
 * - a receipt for a thread this peer is not in moves nothing
 * - a repeated or stale receipt moves nothing, which is what makes it safe to
 *   fire and forget
 * - a thread says who is working in it, and stops saying so when they stop
 *
 * The one thing scripted rather than real is the agent process: a
 * `TeammateSession` stub is handed `PeerSessions`' own emitters — the funnel
 * `PiSession` and `AcpSession` both pour their translated output into — so
 * everything downstream of the protocol is production code, which is why one
 * harness covers both agent kinds. Reaching those emitters costs a documented
 * cast past two privates; there is no seam in `createTeammateSession` to inject
 * a backend and this does not add one.
 *
 * Run: bun scripts/verify-peer-receipts.ts
 */
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "toad-receipts-"));
process.env.TOAD_DATA_DIR = root;

const { PeerSessions } = await import("../src/bun/acp/peers");
const fleet = await import("../src/bun/fleet/fleet");
const personas = await import("../src/bun/store/personas");
const threads = await import("../src/bun/store/threads");
const { threadKey, threadPath } = await import("../src/bun/paths");
const { throughReceipts } = await import("../src/bun/agent/receipts");

import type { PeerActivity, TranscriptEvent } from "../src/shared/types";

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, detail?: unknown) => {
	console.log(
		ok ? `\x1b[32m  PASS\x1b[0m ${label}` : `\x1b[31m  FAIL\x1b[0m ${label}`,
		detail === undefined || ok ? "" : JSON.stringify(detail),
	);
	ok ? pass++ : fail++;
};

// ---------------------------------------------------------------------------
// The room
// ---------------------------------------------------------------------------

const ada = personas.createPersona({ name: "Ada", backendId: "pi" });
const bo = personas.createPersona({ name: "Bo", backendId: "cursor" });
const pair = threadKey(ada.id, bo.id);
threads.ensure(pair, ada.id, bo.id);

const appended: Array<{ threadKey: string; event: TranscriptEvent }> = [];
const updated: Array<{ threadKey: string; event: TranscriptEvent }> = [];
const peers = new PeerSessions({
	peerThreadAppended: (payload) => appended.push(payload),
	peerThreadUpdated: (payload) => updated.push(payload),
	peerActivityChanged: (_payload: Record<string, PeerActivity>) => {},
	transcriptAppended: () => {},
	transcriptUpdated: () => {},
});

/**
 * The production emitters for one delivery, reached past two privates.
 *
 * Everything they do — orientation, the receipt seam, the append, the push —
 * is the code a real delivery runs. Only the thing calling them is a script.
 */
type Emitters = { appendEvent(event: TranscriptEvent): void; updateEvent(event: TranscriptEvent): void };
type Reachable = {
	emitters(
		pair: string,
		key: string,
		callerId: string,
		targetId: string,
		meta: unknown,
		live: unknown,
	): Emitters;
};

function delivery(callerId: string, targetId: string): Emitters {
	const meta = threads.readMeta(pair)!;
	const live = { collector: { replies: [], replyEventIds: [] }, receipts: null };
	return (peers as unknown as Reachable).emitters(
		pair,
		`${pair}|${callerId}->${targetId}`,
		callerId,
		targetId,
		meta,
		live,
	);
}

let clock = 1_700_000_000_000;
const event = (kind: string, over: Record<string, unknown> = {}): TranscriptEvent =>
	({ kind, id: randomUUID(), ts: (clock += 1_000), text: "", ...over }) as TranscriptEvent;

/** The thread as it is on disk, not as the harness remembers it. */
const onDisk = () => threads.load(pair);
const found = (id: string) => onDisk().find((stored) => stored.id === id);
const receiptOf = (id: string) => {
	const stored = found(id);
	return stored && (stored.kind === "user" || stored.kind === "agent") ? stored.receipt : undefined;
};

// ---------------------------------------------------------------------------
// One tick on the way out
// ---------------------------------------------------------------------------

console.log("\nA message entering the thread");

{
	const emitters = delivery(ada.id, bo.id);
	const message = event("user", { text: "How did the deploy go?" });
	emitters.appendEvent(message);

	check("the caller's message is stored sent", receiptOf(message.id) === "sent", receiptOf(message.id));
	check(
		"the push carries the same receipt the file does",
		(appended.at(-1)?.event as { receipt?: string })?.receipt === "sent",
	);
	check("nothing has been read yet", updated.length === 0);

	// The recipient's session so much as thinks: that is a turn.
	emitters.appendEvent(event("thought", { text: "checking" }));
	check("the first sign of a turn reads it", receiptOf(message.id) === "read", receiptOf(message.id));
	check(
		"the read arrives as an update, not a second bubble",
		updated.length === 1 && onDisk().filter((stored) => stored.id === message.id).length === 1,
	);

	const reply = event("agent", { text: "Clean." });
	emitters.appendEvent(reply);
	check("the reply is stored sent", receiptOf(reply.id) === "sent", receiptOf(reply.id));
	emitters.appendEvent(event("turn", { stopReason: "end_turn" }));
	check(
		"nothing local claims the caller read the reply",
		receiptOf(reply.id) === "sent",
		receiptOf(reply.id),
	);
}

// ---------------------------------------------------------------------------
// What a tick refuses to say
// ---------------------------------------------------------------------------

console.log("\nWhat a receipt will not claim");

{
	const emitters = delivery(ada.id, bo.id);
	const message = event("user", { text: "Try the other one." });
	emitters.appendEvent(message);
	emitters.appendEvent(event("notice", { level: "error", text: "the cursor backend exited" }));
	check(
		"an error before the model ran leaves one tick",
		receiptOf(message.id) === "sent",
		receiptOf(message.id),
	);
	emitters.appendEvent(event("agent", { text: "Sorry, back now." }));
	check("the retry's first output reads it after all", receiptOf(message.id) === "read");
}

{
	// The same five texts on both sides of the gate. A tick that could be
	// spoken into existence would be worth nothing.
	const wording = ["", "read", "I have read your message", "receipt: read", "✓✓"];
	let ticked = 0;
	let untouched = 0;
	for (const text of wording) {
		const emitters = delivery(ada.id, bo.id);
		const spoken = event("user", { text });
		emitters.appendEvent(spoken);
		emitters.appendEvent(event("thought", { text }));
		if (receiptOf(spoken.id) === "read") ticked++;

		const other = delivery(ada.id, bo.id);
		const unread = event("user", { text });
		other.appendEvent(unread);
		other.appendEvent(event("notice", { level: "error", text }));
		if (receiptOf(unread.id) === "sent") untouched++;
	}
	check("five different texts tick identically", ticked === wording.length, ticked);
	check("and five identical texts stay unticked without a turn", untouched === wording.length, untouched);
}

// ---------------------------------------------------------------------------
// The reply's second tick, in the same process
// ---------------------------------------------------------------------------

console.log("\nThe reply, read at home");

{
	const emitters = delivery(bo.id, ada.id);
	const asked = event("user", { text: "Anything for me?" });
	emitters.appendEvent(asked);
	const reply = event("agent", { text: "Two things." });
	emitters.appendEvent(reply);

	const before = updated.length;
	const moved = peers.markRead(pair, [reply.id]);
	check("marking the reply read moves exactly one bubble", moved === 1, moved);
	check("the file says read", receiptOf(reply.id) === "read", receiptOf(reply.id));
	check("and one update was pushed", updated.length === before + 1);

	check("a repeat moves nothing", peers.markRead(pair, [reply.id]) === 0);
	check("an unknown id moves nothing", peers.markRead(pair, [randomUUID()]) === 0);
	check("an empty receipt moves nothing", peers.markRead(pair, []) === 0);
}

// ---------------------------------------------------------------------------
// The reply's second tick, over the wire
// ---------------------------------------------------------------------------

console.log("\nThe reply, read on another desk");

/* A real linked desktop, admitted through the real pairing endpoint, so the
 * receipt below is authenticated the way any peer call is. Nothing is
 * listening on a socket: `handleFleetRpc` is the same dispatcher the HTTP
 * surface and the NodeLink both hand their bodies to. */
let readsApplied = 0;
fleet.initFleet({
	createTeammate: () => ({ personaId: "", name: "" }),
	readTranscript: () => null,
	readThread: () => null,
	deliver: async () => ({ ok: false, detail: "not used here" }),
	threadRead: ({ localPersonaId, remoteNodeId, remotePersonaId, eventIds }) => {
		if (!personas.getPersona(localPersonaId)) return 0;
		const key = threadKey(`remote:${remoteNodeId}:${remotePersonaId}`, localPersonaId);
		const moved = peers.markRead(key, eventIds);
		readsApplied += moved;
		return moved;
	},
	httpOrigin: () => "http://127.0.0.1:9999",
});

const invite = fleet.createFleetInvite();
if ("error" in invite) throw new Error(invite.error);
const paired = fleet.handleFleetPair({
	code: invite.code,
	node: { id: "beastie-node", name: "beastie" },
	origin: "http://127.0.0.1:9998",
	token: "their-accept-token",
});
const acceptToken = (paired.body as { token?: string }).token;
if (!acceptToken) throw new Error("pairing did not return a token");

/* Ada answered a teammate that lives on beastie, so the thread is filed here
 * under the caller's remote identity — exactly where a real inbound delivery
 * would have put it. */
const remoteCaller = "remote:beastie-node:windows-guy";
const remotePair = threadKey(remoteCaller, ada.id);
threads.ensure(remotePair, remoteCaller, ada.id);
const remoteEmitters = (() => {
	const meta = threads.readMeta(remotePair)!;
	const live = { collector: { replies: [], replyEventIds: [] }, receipts: null };
	return (peers as unknown as Reachable).emitters(
		remotePair,
		`${remotePair}|${remoteCaller}->${ada.id}`,
		remoteCaller,
		ada.id,
		meta,
		live,
	);
})();

const inbound = event("user", { text: "Can you take the Tuesday review?" });
remoteEmitters.appendEvent(inbound);
const answer = event("agent", { text: "Taken. Posting it at 9." });
remoteEmitters.appendEvent(answer);

const remoteReceipt = (id: string) => {
	const stored = threads.load(remotePair).find((item) => item.id === id);
	return stored && (stored.kind === "user" || stored.kind === "agent") ? stored.receipt : undefined;
};

check(
	"an inbound message from another desk is read the same way",
	remoteReceipt(inbound.id) === "read",
	remoteReceipt(inbound.id),
);
check("the answer starts on one tick", remoteReceipt(answer.id) === "sent", remoteReceipt(answer.id));

{
	const result = await fleet.handleFleetRpc(acceptToken, {
		method: "threadRead",
		params: { localPersonaId: ada.id, remotePersonaId: "windows-guy", eventIds: [answer.id] },
	});
	check("the peer's receipt is accepted", result.status === 200, result);
	check("the answer now has two ticks", remoteReceipt(answer.id) === "read", remoteReceipt(answer.id));
	check("and the desk applied exactly one", readsApplied === 1, readsApplied);
}

{
	// The thread is derived from the authenticated link's node id and the two
	// personas — a caller cannot name a thread it is not in.
	const before = remoteReceipt(inbound.id);
	const result = await fleet.handleFleetRpc(acceptToken, {
		method: "threadRead",
		params: { localPersonaId: ada.id, remotePersonaId: "somebody-else", eventIds: [inbound.id] },
	});
	check("a receipt naming another thread is answered but moves nothing", result.status === 200);
	check("and the thread it aimed at is untouched", remoteReceipt(inbound.id) === before);
}

{
	const result = await fleet.handleFleetRpc("not-a-token", {
		method: "threadRead",
		params: { localPersonaId: ada.id, remotePersonaId: "windows-guy", eventIds: [answer.id] },
	});
	check("an unauthenticated receipt is refused", result.status === 401, result);
}

{
	const result = await fleet.handleFleetRpc(acceptToken, {
		method: "threadRead",
		params: { localPersonaId: ada.id, eventIds: [answer.id] },
	});
	check("a malformed receipt is a bad request", result.status === 400, result);
}

// ---------------------------------------------------------------------------
// The file itself
// ---------------------------------------------------------------------------

console.log("\nThe tape on disk");

{
	const lines = readFileSync(threadPath(remotePair), "utf8").trim().split("\n");
	const parsed = lines.map((line) => JSON.parse(line) as TranscriptEvent);
	check(
		"a read is an append wearing the same id",
		parsed.filter((item) => item.id === answer.id).length === 2,
		parsed.filter((item) => item.id === answer.id).length,
	);
	check(
		"and the fold leaves one bubble at the top rung",
		threads.load(remotePair).filter((item) => item.id === answer.id).length === 1 &&
			remoteReceipt(answer.id) === "read",
	);
	threads.compact(remotePair);
	check("compaction keeps the receipt", remoteReceipt(answer.id) === "read");
}

// ---------------------------------------------------------------------------
// Who is working on this
// ---------------------------------------------------------------------------

console.log("\nThe line at the foot of a thread");

{
	const idle = peers.summariesFor(ada.id).find((row) => row.threadKey === pair);
	check("an idle thread names nobody", idle?.workingPersonaId === undefined, idle?.workingPersonaId);

	/* A delivery in flight, as `deliver` records one: the private set is the
	 * thing summaries read, so the harness sets it rather than spawning a
	 * backend it would then have to wait on. */
	const inFlight = (peers as unknown as { inFlight: Set<string> }).inFlight;
	inFlight.add(`${pair}|${ada.id}->${bo.id}`);
	const busy = peers.summariesFor(ada.id).find((row) => row.threadKey === pair);
	check("a thread mid-delivery names the teammate answering", busy?.workingPersonaId === bo.id, busy);

	const otherSide = peers.summariesFor(bo.id).find((row) => row.threadKey === pair);
	check("both chairs see the same worker", otherSide?.workingPersonaId === bo.id, otherSide);

	inFlight.clear();
	const done = peers.summariesFor(ada.id).find((row) => row.threadKey === pair);
	check("and it stops saying so", done?.workingPersonaId === undefined, done?.workingPersonaId);
}

// ---------------------------------------------------------------------------
// The seam itself, once, so a failure here is not read as a store bug
// ---------------------------------------------------------------------------

{
	const message = event("user", { text: "x" });
	const first = throughReceipts(null, message);
	const second = throughReceipts(first.window, event("agent", { text: "y" }));
	check(
		"the pure seam agrees with everything above",
		(first.event as { receipt?: string }).receipt === "sent" && second.read?.id === message.id,
	);
}

console.log(`\n${pass} pass, ${fail} fail`);
rmSync(root, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
