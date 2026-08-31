/**
 * The room's certificate authority, proved on real doors rather than on paper:
 *
 * - a desk with no certificate mints one root, publishes it as a room record and
 *   serves a leaf signed by it — and `openssl verify` says the chain holds,
 *   rather than this file taking the code's word for it
 * - THE ONE THAT MATTERS: when the desk's address moves, the leaf is reissued
 *   for the new address and the root on disk is byte-identical. The CA bytes
 *   captured *before* the move still verify the leaf served *after* it, both
 *   through openssl and through a live TLS handshake. If that ever stops
 *   holding, installed trust dies on every DHCP lease and the feature has no
 *   point
 * - a second desk in the room converges on the same root and signs its own leaf
 *   under it, so the one file an operator installed opens both doors
 * - a desk holding a root it cannot open serves a self-signed leaf and says so.
 *   It does not mint a second root, and it does not go dark
 * - every key names its curve. macOS LibreSSL writes explicit domain parameters,
 *   Bun's BoringSSL refuses such a key, and `Bun.serve` throws at startup: the
 *   node plane lost a Mac to that for a day in desktop-v0.3.3, and this asserts
 *   on the bytes openssl actually wrote, not on a flag being present in source
 *
 * THE DESKS ARE REAL. Each child is the main process — node server, wire,
 * `startWebMode`, a real HTTPS listener on a real port — in its own scratch
 * `TOAD_DATA_DIR`, and every certificate check reads that desk's own files or
 * connects to that desk's own door.
 *
 * TWO THINGS ARE STAGED, both named where they happen. An address move is a
 * NIC being renumbered, which a verify script may not do, so the harness tells
 * a desk its leaf was minted at an address it no longer has — the same state,
 * through the same trigger the running code uses. And the desk that cannot open
 * the room's root is seeded with the record as the wire would have delivered it,
 * boxed for the desks that were in the room and not for this one.
 *
 *   bun scripts/verify-room-ca.ts
 */
import { X509Certificate } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

type JsonRecord = Record<string, unknown>;

/** The address the harness tells a desk its old leaf was minted at (TEST-NET-3). */
const OLD_ADDRESS = "203.0.113.7";

/** The reserved provider id the room CA lives under, as `web/tls.ts` spells it. */
const CA_PROVIDER = "toad.web-ca";

const CHILD = process.env.TOAD_ROOM_CA_CHILD;
const SEED = process.env.TOAD_ROOM_CA_SEED;

if (SEED) {
	await runSeed(SEED);
} else if (CHILD) {
	await runChild(CHILD);
} else {
	await runParent();
}

/* -------------------------------------------------------------------- seed */

/**
 * Writes one credential record into a desk's store the way sync would, then
 * exits.
 *
 * A desk admitted after the room minted its root holds the record and no box of
 * its own until the owner's next sweep seals one. That state has to exist
 * *before* the desk's first `ensureTls`, and a control action cannot reach a
 * process that has not started, so it is planted here — through
 * `applyRemoteOps`, which is the same call `fleet/sync.ts` makes when the op
 * arrives over a NodeLink, carrying the owner's real seals for the desks that
 * were in the room.
 */
async function runSeed(path: string): Promise<void> {
	const records = await import("../src/bun/store/records");
	const op = JSON.parse(readFileSync(path, "utf8")) as Parameters<
		typeof records.applyRemoteOps
	>[0][number];
	const applied = records.applyRemoteOps([op]);
	if (!applied.applied) throw new Error(`the seeded record was refused: ${applied.reason}`);
}

/* ------------------------------------------------------------------- child */

async function runChild(label: string): Promise<void> {
	const nodePort = Number(process.env.TOAD_NODE_PORT);
	const webPort = Number(process.env.TOAD_WEB_PORT);
	const controlPort = Number(process.env.TOAD_ROOM_CA_CONTROL_PORT);
	if (!nodePort || !webPort || !controlPort) throw new Error("ports are required");

	const fleet = await import("../src/bun/fleet/fleet");
	const wire = await import("../src/bun/fleet/wire");
	const admission = await import("../src/bun/node/admission");
	const identity = await import("../src/bun/node/identity");
	const nodeServer = await import("../src/bun/node/server");
	const credentials = await import("../src/bun/store/credentials");
	const records = await import("../src/bun/store/records");
	const webTls = await import("../src/bun/web/tls");
	const web = await import("../src/bun/web/server");

	const handlers: Record<string, (params: unknown) => Promise<unknown>> = {
		ping: async () => true,
	};
	const resolve = (method: string) => handlers[method];

	fleet.initFleet({
		createTeammate: (draft) => ({ personaId: `${label}-created`, name: draft.name }),
		readTranscript: () => null,
		readThread: () => null,
		deliver: async () => ({ ok: false, detail: "not exercised" }),
		httpOrigin: () => web.httpOrigin(),
		nodeOrigin: nodeServer.nodeOrigin,
	});
	wire.initPeerWires({
		send: (name, payload) => web.webBroadcast(name, payload),
		publishPersonas: () => {},
		resolve,
	});
	nodeServer.startNodeServer(resolve, nodePort, wire.nodeLinkServerHooks);
	web.startWebMode(resolve, webPort);

	/** Everything this desk is currently willing to say about its own door. */
	const door = () => ({
		secureOrigin: web.secureOrigin(),
		fault: web.webTlsFault(),
		trust: webTls.webTlsTrust(),
	});

	const control = Bun.serve({
		hostname: "127.0.0.1",
		port: controlPort,
		async fetch(request) {
			const input = (await request.json()) as { action?: string; [key: string]: unknown };
			try {
				switch (input.action) {
					case "ready":
						return Response.json({
							ok: true,
							result: { identity: identity.nodeIdentity(), ...door() },
						});
					case "door":
						return Response.json({ ok: true, result: door() });
					case "invite":
						return Response.json({ ok: true, result: admission.createNodeInvite() });
					case "join": {
						const result = await admission.joinNodeInvite(String(input.origin), String(input.code));
						if (result.ok) await wire.syncPeerWires();
						return Response.json({ ok: true, result });
					}
					case "sync":
						await wire.syncPeerWires();
						return Response.json({ ok: true, result: true });
					case "links":
						return Response.json({ ok: true, result: wire.nodeLinkSnapshot() });
					case "credentials":
						return Response.json({ ok: true, result: credentials.listCredentials() });
					/* The record exactly as it sits here, so the parent can hand
					 * another desk the bytes a NodeLink would have carried. */
					case "record":
						return Response.json({
							ok: true,
							result: records.getRecord("credential", String(input.id)) ?? null,
						});
					case "stop":
						queueMicrotask(() => {
							web.stopWebMode();
							nodeServer.stopNodeServer();
							control.stop(true);
							globalThis.process.exit(0);
						});
						return Response.json({ ok: true, result: true });
					default:
						return Response.json({ ok: false, error: `unknown action ${input.action}` }, { status: 400 });
				}
			} catch (error) {
				return Response.json(
					{ ok: false, error: error instanceof Error ? error.message : String(error) },
					{ status: 500 },
				);
			}
		},
	});
}

/* ------------------------------------------------------------------ parent */

type Ports = { node: number; web: number; control: number };
type Child = {
	label: string;
	dir: string;
	ports: Ports;
	httpsPort: number;
	process: ReturnType<typeof Bun.spawn>;
	command<T>(input: JsonRecord): Promise<T>;
};
type Trust = { path: string | null; fingerprint: string | null; roomCa: boolean };
type Door = { secureOrigin: string | null; fault: string | null; trust: Trust };
type Ready = Door & { identity: { id: string; name: string } };
type Credential = {
	id: string;
	providerId: string;
	ownerNode: string;
	replicate: boolean;
	revoked: boolean;
	usableHere: boolean;
	sealedTo: string[];
};
/** A record as the store holds it, which is also what an op carries. */
type StoredRecord = {
	id: string;
	ownerNode: string;
	ownerEpoch: number;
	version: number;
	updatedAt: number;
	replicated: JsonRecord;
};

async function runParent(): Promise<void> {
	const root = mkdtempSync(join(tmpdir(), "toad-room-ca-"));
	const base = 55_200 + Math.floor(Math.random() * 400);
	let a = spawnChild("a", { node: base, web: base + 20, control: base + 40 }, join(root, "a"));
	const b = spawnChild("b", { node: base + 1, web: base + 21, control: base + 41 }, join(root, "b"));
	const live: Child[] = [a, b];

	try {
		const [readyA, readyB] = await Promise.all([
			eventually(() => a.command<Ready>({ action: "ready" }), "desk A ready"),
			eventually(() => b.command<Ready>({ action: "ready" }), "desk B ready"),
		]);
		if (!readyA.secureOrigin || !readyB.secureOrigin) {
			throw new Error(
				"no HTTPS door — openssl is what mints the certificate, and without one there is nothing here to prove",
			);
		}

		/**
		 * The room's root once there is a room, and the file an operator installs.
		 *
		 * Filled in by the step that forms the room, because until then there is no
		 * room to install anything for: two desks that minted before either had
		 * heard of the other converge on one of the two, and a client that installed
		 * the loser's is a client that installed a certificate for a room of one.
		 * Everything after that step is checked against these bytes and no others.
		 */
		let installed = Buffer.alloc(0);

		await step("a desk with no certificate mints the room's root and serves a leaf under it", async () => {
			const rows = await liveRoots(a);
			if (rows.length !== 1) throw new Error(`desk A published ${rows.length} roots`);
			if (!rows[0]?.replicate || !rows[0]?.usableHere) {
				throw new Error("the root was published without being shared, or without being usable here");
			}

			const minted = readFileSync(caFile(a));
			const ca = new X509Certificate(minted);
			if (!ca.ca) throw new Error("the room's root is not a CA certificate");
			const caText = openssl(["x509", "-in", caFile(a), "-noout", "-text"]);
			if (!caText.out.includes("CA:TRUE") || !caText.out.includes("Certificate Sign")) {
				throw new Error("the root may not sign certificates, which is all a root is for");
			}

			/* openssl's answer, not this tree's: `verify` builds the chain with a
			 * library that had no hand in minting it. */
			const chain = openssl(["verify", "-CAfile", caFile(a), certFile(a)]);
			if (!chain.ok) throw new Error(`the leaf does not chain to the root: ${chain.out.trim()}`);

			const leaf = new X509Certificate(readFileSync(certFile(a)));
			if (leaf.ca) throw new Error("the leaf this desk serves is itself a CA");
			if (leaf.issuer !== ca.subject) throw new Error("the leaf names some other issuer");
			// Apple refuses a locally trusted certificate without serverAuth, so a
			// leaf that lacks it is trusted and still unusable.
			if (!leaf.keyUsage?.includes("1.3.6.1.5.5.7.3.1")) {
				throw new Error("the leaf is not marked for server authentication");
			}

			// And the door actually answers a client holding only that one file.
			await handshake(a, minted.toString("utf8"), "desk A");

			const trust = readyA.trust;
			if (!trust.roomCa || trust.path !== caFile(a)) {
				throw new Error(`the desk offers ${String(trust.path)} rather than the room's root`);
			}
			if (trust.fingerprint !== sha256Of(caFile(a))) {
				throw new Error("the fingerprint the desk shows is not the root's");
			}
		});

		await step("every key names its curve, which is what LibreSSL drops", async () => {
			/* The 0.3.3 incident, in one assertion: a key carrying explicit domain
			 * parameters is one Bun's BoringSSL refuses, and `Bun.serve` throws at
			 * startup rather than serving. Read off the bytes openssl wrote — a
			 * flag can be present in source and still not reach the invocation
			 * that generated the key. */
			const asn1 = openssl(["asn1parse", "-in", keyFile(a)]);
			if (!asn1.ok) throw new Error(`the leaf key does not parse: ${asn1.out.trim()}`);
			if (!asn1.out.includes(":prime256v1")) {
				throw new Error("the leaf key does not name its curve by OID");
			}
			if (asn1.out.includes(":prime-field")) {
				throw new Error("the leaf key carries explicit domain parameters — Bun will refuse it");
			}
			const text = openssl(["pkey", "-in", keyFile(a), "-noout", "-text"]);
			if (!text.out.includes("ASN1 OID: prime256v1") || text.out.includes("Field Type")) {
				throw new Error(`the leaf key is not a named-curve key: ${text.out.trim()}`);
			}
			/* Both certificates carry the same answer for the keys behind them,
			 * including the root's — whose private half never touches disk, so its
			 * public parameters are the only place to read it. */
			for (const [what, file] of [
				["root", caFile(a)],
				["leaf", certFile(a)],
			] as const) {
				const spki = openssl(["asn1parse", "-in", file]);
				if (!spki.out.includes(":prime256v1") || spki.out.includes(":prime-field")) {
					throw new Error(`the ${what}'s public key carries explicit parameters`);
				}
			}
		});

		await step("a second desk in the room serves a door the same file opens", async () => {
			const invite = await a.command<{ origin?: string; code?: string; error?: string }>({
				action: "invite",
			});
			if (!invite.origin || !invite.code) throw new Error(`invite failed: ${invite.error}`);
			const joined = await b.command<{ ok: boolean; error?: string }>({
				action: "join",
				origin: invite.origin,
				code: invite.code,
			});
			if (!joined.ok) throw new Error(`join failed: ${joined.error}`);

			/* Both desks minted a root before either had heard of the other, so the
			 * room starts with two and has to converge — on the older record, a rule
			 * every desk computes from replicated fields alone rather than by asking
			 * anybody. Which of the two wins is a coin flip decided by a millisecond,
			 * and this makes no assumption about it: what matters is that the room
			 * ends up holding one root and that both desks are serving under it. */
			await eventually(async () => {
				await Promise.all([a.command({ action: "sync" }), b.command({ action: "sync" })]);
				if (!readFileSync(caFile(a)).equals(readFileSync(caFile(b)))) {
					// Which roots the room is holding and what each desk can do with
					// them is the whole story of a convergence that did not happen.
					const held = (await allRoots(a))
						.map((row) => `${row.id.slice(0, 8)} of ${row.ownerNode.slice(0, 8)} use=${row.usableHere} seal=${row.sealedTo.join("+")}`)
						.join(", ");
					const heldB = (await allRoots(b))
						.map((row) => `${row.id.slice(0, 8)} use=${row.usableHere} seal=${row.sealedTo.join("+")}`)
						.join(", ");
					throw new Error(
						`the desks still hold different roots (A ${sha256Of(caFile(a)).slice(0, 12)}, B ${sha256Of(caFile(b)).slice(0, 12)}; A sees ${held}; B sees ${heldB})`,
					);
				}
				for (const desk of [a, b]) {
					const roots = await liveRoots(desk);
					if (roots.length !== 1) throw new Error(`desk ${desk.label} sees ${roots.length} roots`);
					const door = await desk.command<Door>({ action: "door" });
					if (!door.trust.roomCa || door.trust.fingerprint !== sha256Of(caFile(desk))) {
						throw new Error(`desk ${desk.label} does not yet offer the room's root as trust`);
					}
					/* Adopting the room's root replaces a live listener, and a desk
					 * that lost its HTTPS door in the exchange has been made worse by
					 * the thing that was supposed to make it trustworthy. */
					if (!door.secureOrigin || door.fault) {
						throw new Error(
							`desk ${desk.label} came out of the adoption without a door: ${String(door.fault)}`,
						);
					}
				}
				return true;
			}, "the room converges on one root", 45_000);

			/* From here on, this is the room's certificate: the one file an operator
			 * installs on a client machine, and the only bytes the checks below are
			 * allowed to use. */
			installed = readFileSync(caFile(a));

			const leafA = new X509Certificate(readFileSync(certFile(a)));
			const leafB = new X509Certificate(readFileSync(certFile(b)));
			if (leafA.fingerprint256 === leafB.fingerprint256) {
				throw new Error("both desks are serving the same leaf, and therefore the same private key");
			}
			for (const desk of [a, b]) {
				const chain = openssl(["verify", "-CAfile", caFile(a), certFile(desk)]);
				if (!chain.ok) {
					throw new Error(`the room's root does not verify desk ${desk.label}: ${chain.out.trim()}`);
				}
				// One installed file, both doors — the promise `docs/client-seat.md`
				// makes for a grant that names more than one desk.
				await handshake(desk, installed.toString("utf8"), `desk ${desk.label.toUpperCase()}`);
			}

			/* The desk that lost gave its own root up rather than leaving two on the
			 * books — and as a revocation, which is the fact that reaches whoever
			 * held a sealed copy. */
			const roots = await allRoots(a);
			const winner = roots.find((row) => !row.revoked);
			const loser = roots.find((row) => row.revoked);
			if (!loser || loser.ownerNode === winner?.ownerNode) {
				throw new Error("the desk that lost the race never revoked its own root");
			}
			const owners = [readyA.identity.id, readyB.identity.id];
			if (!owners.includes(loser.ownerNode) || !owners.includes(String(winner?.ownerNode))) {
				throw new Error("the room's roots belong to desks that are not in it");
			}
		});

		await step("the desk moves and only the leaf does", async () => {
			const before = new X509Certificate(readFileSync(certFile(a)));
			const rootBefore = await liveRoots(a);

			/* The desk wakes up somewhere else: it goes down, its leaf is left
			 * saying it was minted for an address this box does not have, and it
			 * comes back. A harness may not renumber an interface, but this is the
			 * state a renumbered one leaves behind and the path the running code
			 * takes out of it — `ensureTls` finds a leaf that does not name where
			 * the desk is, and reissues it under the root it already holds. */
			a = await restart(a, live, () => {
				const metaFile = join(a.dir, "web-tls", "meta.json");
				const meta = JSON.parse(readFileSync(metaFile, "utf8")) as { ca: string | null };
				writeFileSync(
					metaFile,
					`${JSON.stringify({ ips: [OLD_ADDRESS], ca: meta.ca }, null, 2)}\n`,
					"utf8",
				);
			});
			const moved = await a.command<Door>({ action: "door" });
			if (moved.fault) throw new Error(`the door came back with a fault: ${moved.fault}`);
			if (!moved.secureOrigin) throw new Error("the desk lost its HTTPS door on an address change");

			/* The whole argument for a room CA: trust an operator installed
			 * survives DHCP. Byte-for-byte, because a re-minted root with the same
			 * subject would look identical in every other check and still be a
			 * file every client machine has to be visited about. */
			if (!readFileSync(caFile(a)).equals(installed)) {
				throw new Error("the root on disk changed when the desk's address did");
			}
			const rootsAfter = await liveRoots(a);
			if (rootsAfter.length !== 1 || rootsAfter[0]?.id !== rootBefore[0]?.id) {
				throw new Error("the room's root record was replaced rather than reused");
			}

			const after = new X509Certificate(readFileSync(certFile(a)));
			if (after.fingerprint256 === before.fingerprint256) {
				throw new Error("the leaf was not reissued for the address the desk now has");
			}
			// Reissued from the desk's addresses, not replayed from the old meta:
			// a leaf that still named where the desk used to be is unreachable.
			if (after.subjectAltName?.includes(OLD_ADDRESS)) {
				throw new Error(`the new leaf still names ${OLD_ADDRESS}`);
			}
			if (!after.subjectAltName?.includes("IP Address:127.0.0.1")) {
				throw new Error(`the new leaf names ${String(after.subjectAltName)}`);
			}

			/* Verified against the bytes captured before the move — this is a
			 * client that installed one file, was told nothing since, and is
			 * meeting a certificate that did not exist when it was told. */
			const stale = join(root, "installed-ca.pem");
			writeFileSync(stale, installed);
			const chain = openssl(["verify", "-CAfile", stale, certFile(a)]);
			if (!chain.ok) {
				throw new Error(`the installed root no longer verifies this desk: ${chain.out.trim()}`);
			}
			await handshake(a, installed.toString("utf8"), "desk A after its address moved");
		});

		await step("a desk that cannot open the room's root serves a door anyway", async () => {
			const room = (await liveRoots(a))[0];
			if (!room) throw new Error("the room has no root to withhold");
			/* The record as desk A holds it: boxed for the desks that were in the
			 * room when it was sealed, and for nobody else. Desk C is what a desk
			 * admitted a minute later looks like before the owner's next sweep. */
			const record = await a.command<StoredRecord>({ action: "record", id: room.id });
			const ports = { node: base + 2, web: base + 22, control: base + 42 };
			const c = spawnChild("c", ports, join(root, "c"), {
				kind: "credential",
				id: record.id,
				ownerNode: record.ownerNode,
				ownerEpoch: record.ownerEpoch,
				version: record.version,
				op: "put",
				payload: record.replicated,
				at: record.updatedAt,
			});
			live.push(c);
			const readyC = await eventually(() => c.command<Ready>({ action: "ready" }), "desk C ready");

			if (!readyC.secureOrigin) {
				throw new Error("a desk that could not open the room's root went dark instead of plain");
			}
			if (readyC.fault) throw new Error(`desk C reports a TLS fault: ${readyC.fault}`);
			// A missing box is not a reason to mint a second root: a room that
			// answered every dark moment with one would end up with a root per desk
			// and nothing an operator could install.
			const roots = await liveRoots(c);
			if (roots.length !== 1 || roots[0]?.id !== room.id) {
				throw new Error(`desk C holds ${roots.length} live roots — it minted one of its own`);
			}
			if (roots[0]?.usableHere) throw new Error("desk C could open a box that was never sealed to it");
			if (existsSync(caFile(c))) {
				throw new Error("desk C published a root it cannot sign with as the one to install");
			}

			// The honest fallback, and honestly labelled: this desk's own leaf,
			// covering this desk alone.
			const leaf = new X509Certificate(readFileSync(certFile(c)));
			if (leaf.issuer !== leaf.subject) throw new Error("desk C's leaf is not self-signed");
			if (readyC.trust.roomCa || readyC.trust.path !== certFile(c)) {
				throw new Error("desk C offers a room CA it does not have");
			}
			const chain = openssl(["verify", "-CAfile", caFile(a), certFile(c)]);
			if (chain.ok) throw new Error("the room's root verified a leaf it never signed");

			// It still serves — a phone taps through the warning, which is exactly
			// what this desk had before the room had a CA at all.
			await handshake(c, null, "desk C on its own leaf");
		});

		console.log(
			"room-ca: one root minted and published as a room record, its leaf chained under openssl verify and served to a client holding only that file; the desk's address moved and the leaf was reissued for the new one while the root stayed byte-identical, so the certificate installed before the move still verified the door after it; a second desk converged on the same root, revoked its own and served its own leaf under it, and one file opened both doors; a desk holding a root it cannot open served a self-signed door rather than going dark, without minting a second root; and every key on disk names its curve, which is the day desktop-v0.3.3 paid for",
		);
	} finally {
		await Promise.all(live.map((child) => child.command({ action: "stop" }).catch(() => undefined)));
		await Promise.all(live.map((child) => child.process.exited));
		rmSync(root, { recursive: true, force: true });
	}
}

/* ----------------------------------------------------------------- helpers */

function caFile(child: Child): string {
	return join(child.dir, "web-tls", "ca.pem");
}
function certFile(child: Child): string {
	return join(child.dir, "web-tls", "cert.pem");
}
function keyFile(child: Child): string {
	return join(child.dir, "web-tls", "key.pem");
}

/** One openssl invocation, with both streams kept for the failure message. */
function openssl(args: string[]): { ok: boolean; out: string } {
	const run = Bun.spawnSync(["openssl", ...args], { stdout: "pipe", stderr: "pipe" });
	return {
		ok: run.exitCode === 0,
		out: `${run.stdout.toString()}${run.stderr.toString()}`,
	};
}

/** A certificate file's SHA-256, in the lowercase separator-free dialect Toad pins in. */
function sha256Of(path: string): string {
	return new X509Certificate(readFileSync(path)).fingerprint256.replace(/:/g, "").toLowerCase();
}

/**
 * A real TLS handshake against a desk's own door, verified or not.
 *
 * `ca` is what the client was given and all it was given, so a pass means the
 * chain, the SAN and the key all held on the wire rather than on disk. Loopback
 * rather than the desk's advertised LAN origin: both are in the leaf, and only
 * one of them is the same address on every machine this harness runs on.
 */
async function handshake(child: Child, ca: string | null, what: string): Promise<void> {
	const options = ca ? { tls: { ca } } : { tls: { rejectUnauthorized: false } };
	const answer = await eventually(
		() =>
			fetch(`https://127.0.0.1:${child.httpsPort}/`, {
				...(options as RequestInit),
				signal: AbortSignal.timeout(10_000),
			}),
		`${what} answered a client trusting only what it was handed`,
	);
	if (!answer.ok) throw new Error(`${what} answered ${answer.status}`);
	await answer.text();
}

/** The room's live roots as this desk sees them. */
async function liveRoots(child: Child): Promise<Credential[]> {
	return (await allRoots(child)).filter((row) => !row.revoked);
}

async function allRoots(child: Child): Promise<Credential[]> {
	const rows = await child.command<Credential[]>({ action: "credentials" });
	return rows.filter((row) => row.providerId === CA_PROVIDER);
}

/**
 * Takes a desk down, changes the world under it, and brings it back.
 *
 * A process restart rather than a stop and start inside one: a desk that has
 * moved network is a desk that came back up somewhere else, and the check is
 * about what its *first* `ensureTls` does with what it finds on disk.
 */
async function restart(child: Child, live: Child[], between: () => void): Promise<Child> {
	// Only the child this harness spawned, by the handle it captured — never a
	// name, a path or a port sweep.
	await child.command({ action: "stop" }).catch(() => undefined);
	await child.process.exited;
	live.splice(live.indexOf(child), 1);

	between();

	const fresh = spawnChild(child.label, child.ports, child.dir);
	live.push(fresh);
	await eventually(() => fresh.command<Ready>({ action: "ready" }), `desk ${child.label} came back`);
	return fresh;
}

function spawnChild(label: string, ports: Ports, dataDir: string, seed?: JsonRecord): Child {
	const { node: nodePort, web: webPort, control: controlPort } = ports;
	/* `startWebMode` refuses without a built mainview, and none of this has
	 * anything to do with the SPA. Each desk gets a placeholder bundle in its own
	 * scratch cwd rather than this harness running a `vite build` under whatever
	 * dev instance is open. */
	const views = join(dataDir, "cwd", "dist");
	mkdirSync(views, { recursive: true });
	writeFileSync(join(views, "index.html"), "<!doctype html><title>verify</title>\n", "utf8");

	const env = {
		...globalThis.process.env,
		TOAD_ROOM_CA_CHILD: label,
		TOAD_NODE_NAME: `desk-${label}`,
		TOAD_NODE_PORT: String(nodePort),
		TOAD_WEB_PORT: String(webPort),
		TOAD_WEB_HTTPS_PORT: String(webPort + 100),
		/* The seat's loopback door, off its fixed default so two harness desks
		   do not fight over one port — and never over a live desk's. */
		TOAD_WEB_LOOPBACK_PORT: String(webPort + 200),
		TOAD_ROOM_CA_CONTROL_PORT: String(controlPort),
		TOAD_DATA_DIR: dataDir,
	};

	// The record lands before the desk starts, because the state being checked is
	// what this desk's *first* `ensureTls` does about a root it cannot open.
	if (seed) {
		const path = join(dataDir, "seed-op.json");
		writeFileSync(path, JSON.stringify(seed), "utf8");
		const planted = Bun.spawnSync([process.execPath, fileURLToPath(import.meta.url)], {
			env: { ...env, TOAD_ROOM_CA_SEED: path },
			stdout: "inherit",
			stderr: "inherit",
		});
		if (planted.exitCode !== 0) throw new Error(`could not seed desk ${label}`);
	}

	const childProcess = Bun.spawn([process.execPath, fileURLToPath(import.meta.url)], {
		cwd: join(dataDir, "cwd"),
		env,
		stdout: "inherit",
		stderr: "inherit",
	});
	return {
		label,
		dir: dataDir,
		ports,
		httpsPort: webPort + 100,
		process: childProcess,
		async command<T>(input: JsonRecord): Promise<T> {
			const response = await fetch(`http://127.0.0.1:${controlPort}`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(input),
				signal: AbortSignal.timeout(20_000),
			});
			const body = (await response.json()) as { ok: boolean; result?: T; error?: string };
			if (!response.ok || !body.ok) throw new Error(`${label}: ${body.error ?? response.status}`);
			return body.result as T;
		},
	};
}

async function step<T>(name: string, fn: () => Promise<T>): Promise<T> {
	try {
		return await fn();
	} catch (error) {
		throw new Error(`[${name}] ${error instanceof Error ? error.message : String(error)}`);
	}
}

async function eventually<T>(run: () => Promise<T>, label: string, timeoutMs = 15_000): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	let last: unknown;
	for (;;) {
		try {
			return await run();
		} catch (error) {
			last = error;
			if (Date.now() > deadline) {
				throw new Error(`${label}: ${last instanceof Error ? last.message : String(last)}`);
			}
			await Bun.sleep(200);
		}
	}
}
