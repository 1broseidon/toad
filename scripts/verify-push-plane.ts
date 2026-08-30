/**
 * Three isolated desks proving that a phone paired with one of them can be
 * reached from any of them — end to end over the real node plane, the real
 * record store and the real seal:
 *
 * - a phone registered on A becomes addressable on B and C, byte for byte,
 *   because the registration replicates and each desk opens its own box
 * - the signing key replicates the same way, because an address you cannot post
 *   to is not reach. Both halves, or the feature is half a feature
 * - B's box is noise to C. C is handed B's ciphertext and its own, and opens
 *   exactly one of them; the token appears in no desk's room-level view
 * - it all STAYS true with desk A killed. This is the whole argument: the
 *   pairing desk is not a mute button
 * - a prune travels. B watches Apple reject the token, stops using it at once,
 *   and — because only the owner may publish a fact — keeps telling A until A
 *   says so to the room, at which point C stops too
 * - a prune names a generation, so a report that crosses paths with the phone's
 *   next launch cannot kill the token that replaced it
 * - unpairing is a teardown, not a flag: with C dark, the withdrawal reports C
 *   as pending and B as confirmed, and completes when C comes back
 *
 * And then the other half of the promise — that reach from everywhere is still
 * ONE notification. A fake APNs stands in for Apple (`TOAD_APNS_HOST_STUB`),
 * with a listener per desk so the port a post arrives on names the desk that
 * sent it. That is the only way to count: Apple will not tell us, and the
 * collapse id that folds duplicates into one banner would hide the very defect
 * this is looking for. So:
 *
 * - an event on a desk that neither owns the phone nor holds its socket puts
 *   exactly one post at Apple, and the owning desk is the one that made it
 * - with the owner dead, the same event still puts exactly one post — from the
 *   stand-in the whole room would have named, not from whoever woke up first
 * - a pruned address is silence, on every desk, not just the one that watched
 *   Apple reject it
 * - the phone's next token is buzzed again, once, by its owner
 *
 * The key is self-signed, so a real send would only ever earn
 * `InvalidProviderToken` — `verify-push.ts` covers the shape of a real
 * conversation with Apple.
 *
 *   bun scripts/verify-push-plane.ts
 */
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createSecureServer, type Http2SecureServer } from "node:http2";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { RoomCredential, SessionInfo, SessionState } from "../src/shared/types";
import type { PushCredentialStatus } from "../src/bun/push/apns";
import type { PushRegistration, PushTarget } from "../src/bun/store/push";

type JsonRecord = Record<string, unknown>;

const CHILD = process.env.TOAD_PUSH_CHILD;

const FIRST_TOKEN = "a1".repeat(32);
const SECOND_TOKEN = "b2".repeat(32);

if (CHILD) {
	await runChild(CHILD);
} else {
	await runParent();
}

async function runChild(label: string): Promise<void> {
	const nodePort = Number(process.env.TOAD_NODE_PORT);
	const controlPort = Number(process.env.TOAD_PUSH_CONTROL_PORT);
	if (!nodePort || !controlPort) throw new Error("node and control ports are required");

	const fleet = await import("../src/bun/fleet/fleet");
	const wire = await import("../src/bun/fleet/wire");
	const pushPlane = await import("../src/bun/fleet/push");
	const credentialPlane = await import("../src/bun/fleet/credentials");
	const push = await import("../src/bun/store/push");
	const credentials = await import("../src/bun/store/credentials");
	const records = await import("../src/bun/store/records");
	const seal = await import("../src/bun/node/seal");
	const identity = await import("../src/bun/node/identity");
	const nodeServer = await import("../src/bun/node/server");
	const devices = await import("../src/bun/web/devices");
	const apns = await import("../src/bun/push/apns");
	const notify = await import("../src/bun/push/notify");
	const desktop = await import("../src/bun/push/desktop");
	const settings = await import("../src/bun/store/settings");

	// A headless desk must not shell out to notify-send once per envelope; the
	// claim under test is what reaches Apple, not what reaches this screen.
	desktop.setDesktopPoster(() => {});
	settings.updateSettings({ push: { enabled: true }, desktop: { enabled: false } });

	/** One teammate event, as the supervisor's broadcast would deliver it. */
	const session = (personaId: string, state: SessionState): SessionInfo => ({
		personaId,
		state,
		contextRestored: false,
		models: [],
		modes: [],
		configs: [],
		slashCommands: [],
		capabilities: { loadSession: false, resume: false, fork: false, mcpHttp: false, image: false },
	});

	const handlers: Record<string, (params: unknown) => Promise<unknown>> = {
		listPersonas: async () => [],
	};
	const resolve = (method: string) => handlers[method];

	fleet.initFleet({
		createTeammate: (draft) => ({ personaId: `${label}-created`, name: draft.name }),
		readTranscript: () => null,
		readThread: () => null,
		deliver: async () => ({ ok: false, detail: "not exercised" }),
		httpOrigin: () => null,
		nodeOrigin: nodeServer.nodeOrigin,
	});
	wire.initPeerWires({ send: () => {}, publishPersonas: () => {}, resolve });
	nodeServer.startNodeServer(resolve, nodePort, wire.nodeLinkServerHooks);

	/** The recipient boxes on this desk's copy of a registration record. */
	const boxesOf = (id: string): Record<string, unknown> => {
		const record = records.getRecord("push", id);
		const seals = record?.replicated.seals;
		return seals && typeof seals === "object" ? (seals as Record<string, unknown>) : {};
	};

	/** This desk's own APNs credential row, whoever owns it. */
	const keyRow = (): RoomCredential | undefined =>
		credentials.listCredentials().find((row) => row.providerId === apns.APNS_PROVIDER_ID);

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
							result: { identity: identity.nodeIdentity(), origin: nodeServer.nodeOrigin() },
						});
					case "invite":
						return Response.json({ ok: true, result: fleet.createFleetInvite() });
					case "join": {
						const result = await fleet.joinFleet({
							origin: String(input.origin),
							code: String(input.code),
						});
						if (result.ok) await wire.syncPeerWires();
						return Response.json({ ok: true, result });
					}
					case "sync":
						await wire.syncPeerWires();
						return Response.json({ ok: true, result: { synced: true } });
					case "settle":
						await Promise.all([pushPlane.syncRoomPush(), credentialPlane.syncRoomCredentials()]);
						return Response.json({ ok: true, result: { settled: true } });
					case "peers":
						return Response.json({ ok: true, result: fleet.listFleetPeers() });
					case "links":
						return Response.json({ ok: true, result: wire.nodeLinkSnapshot() });

					// ------------------------------------------------ the signing key
					case "key-install": {
						const result = apns.installPushKey({
							pem: String(input.pem),
							keyId: "ABCD123456",
							teamId: "TEAM123456",
						});
						return Response.json({ ok: true, result });
					}
					case "key-replicate": {
						const row = keyRow();
						if (!row) throw new Error("no APNs credential to replicate");
						credentials.setCredentialReplication(row.id, input.replicate === true);
						await credentialPlane.syncRoomCredentials();
						return Response.json({ ok: true, result: { id: row.id } });
					}
					case "key-status":
						return Response.json({ ok: true, result: apns.pushCredentials() });

					// ----------------------------------------------- the registration
					case "push-pair": {
						const code = devices.createPairing();
						const device = devices.claimPairing(code, String(input.name ?? "verify-phone"));
						if (!device) throw new Error("pairing should claim");
						return Response.json({ ok: true, result: { deviceId: device.id } });
					}
					case "push-register": {
						const registration = push.registerPushDevice({
							deviceId: String(input.deviceId),
							token: String(input.token),
							environment: "sandbox",
						});
						await pushPlane.syncRoomPush();
						return Response.json({ ok: true, result: registration });
					}
					case "push-list":
						return Response.json({ ok: true, result: push.listPushRegistrations() });
					case "push-fanout":
						return Response.json({ ok: true, result: push.pushFanout() });
					case "push-boxes":
						return Response.json({
							ok: true,
							result: Object.keys(boxesOf(String(input.id))).sort(),
						});
					case "push-open-box": {
						// Whatever box is addressed to `recipient`, opened with THIS
						// desk's identity. Only the desk it names may succeed.
						const sealed = boxesOf(String(input.id))[String(input.recipient)];
						const opened = seal.isSealedSecret(sealed)
							? (seal.openSealed(sealed, String(input.id)) ?? null)
							: null;
						return Response.json({ ok: true, result: { opened } });
					}
					case "push-dead": {
						const pruned = push.reportPushTokenDead(
							String(input.id),
							typeof input.generation === "number" ? input.generation : undefined,
						);
						await pushPlane.syncRoomPush();
						return Response.json({ ok: true, result: { pruned } });
					}
					case "push-unpair": {
						const removed = push.unpairPushDevice(String(input.id));
						await pushPlane.syncRoomPush();
						return Response.json({ ok: true, result: { removed } });
					}

					// ---------------------------------------------------- the send path
					case "elect":
						return Response.json({ ok: true, result: pushPlane.electPushSenders() });
					case "fire": {
						/* A teammate finishing a turn, through the same seam the
						 * supervisor uses. Everything after this — election, the
						 * envelope, the post — is the real path. */
						const personaId = String(input.personaId);
						notify.observeSession(session(personaId, "thinking"));
						notify.observeSession(session(personaId, "ready"));
						notify.forgetPersonaState(personaId);
						return Response.json({ ok: true, result: { fired: personaId } });
					}
					case "stop":
						setTimeout(() => {
							nodeServer.stopNodeServer();
							control.stop(true);
							process.exit(0);
						}, 0);
						return Response.json({ ok: true });
					default:
						return Response.json({ ok: false, error: "unknown action" }, { status: 400 });
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

type Child = {
	label: string;
	process: ReturnType<typeof Bun.spawn>;
	command<T>(input: JsonRecord): Promise<T>;
};

type Ready = { identity: { id: string; name: string }; origin: string };

/** One post that reached "Apple", and which desk put it there. */
type Post = { desk: string; token: string; collapseId: string | null };

/**
 * A fake APNs: one HTTP/2 listener per desk, all recording into one list.
 *
 * A listener per desk rather than a header, because the sender must be
 * identifiable without production code carrying a field that only a test
 * reads. The port a request arrives on is a fact about who opened the
 * connection and costs the desk nothing to report.
 */
function fakeApns(
	ports: Record<string, number>,
	tls: { key: string; cert: string },
): { posts: Post[]; close(): void } {
	const posts: Post[] = [];
	const servers: Http2SecureServer[] = [];
	for (const [desk, port] of Object.entries(ports)) {
		const server = createSecureServer({ key: tls.key, cert: tls.cert });
		server.on("stream", (stream, headers) => {
			stream.on("data", () => {});
			stream.on("end", () => {
				const path = String(headers[":path"] ?? "");
				posts.push({
					desk,
					token: path.replace("/3/device/", ""),
					collapseId: (headers["apns-collapse-id"] as string) ?? null,
				});
				stream.respond({ ":status": 200 });
				stream.end();
			});
		});
		server.on("error", () => {});
		server.listen(port, "127.0.0.1");
		servers.push(server);
	}
	return {
		posts,
		close() {
			for (const server of servers) server.close();
		},
	};
}

/**
 * Counts what one event produced, then waits to see whether a second post
 * follows.
 *
 * The settle is the whole point: a double-send is two desks racing, and the
 * loser can be a second or two behind. Asserting on the first post to arrive
 * would pass against exactly the defect this exists to catch.
 */
async function postsFor(
	posts: Post[],
	fire: () => Promise<unknown>,
	expected: number,
	label: string,
): Promise<Post[]> {
	posts.length = 0;
	await fire();
	if (expected > 0) {
		await eventually(
			async () => {
				if (posts.length === 0) throw new Error("nothing reached Apple");
				return true;
			},
			`${label}: nothing was sent at all`,
			20_000,
		);
	}
	await new Promise((resolve) => setTimeout(resolve, 2_000));
	if (posts.length !== expected) {
		throw new Error(
			`${label}: expected ${expected} post(s), got ${posts.length} — ${posts
				.map((post) => post.desk)
				.join(", ")}`,
		);
	}
	return [...posts];
}

async function runParent(): Promise<void> {
	const root = mkdtempSync(join(tmpdir(), "toad-push-plane-"));
	const base = 52_400 + Math.floor(Math.random() * 300);
	const dirs = { a: join(root, "a"), b: join(root, "b"), c: join(root, "c") };
	const ports = {
		a: { node: base, control: base + 10, apns: base + 20 },
		b: { node: base + 1, control: base + 11, apns: base + 21 },
		c: { node: base + 2, control: base + 12, apns: base + 22 },
	};

	// The fake Apple's own certificate. Named to the children through the stub
	// so nothing in this run disables verification — a harness that taught a
	// desk to trust anything would be proving something else.
	const certFile = join(root, "apns-cert.pem");
	const keyFile = join(root, "apns-key.pem");
	const openssl = Bun.spawnSync(
		[
			"openssl", "req", "-x509", "-newkey", "ec",
			"-pkeyopt", "ec_paramgen_curve:prime256v1",
			"-pkeyopt", "ec_param_enc:named_curve",
			"-keyout", keyFile, "-out", certFile,
			"-days", "2", "-nodes", "-subj", "/CN=fake-apns",
			"-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1",
		],
		{ stdout: "ignore", stderr: "pipe" },
	);
	if (openssl.exitCode !== 0) throw new Error(`could not make a certificate for the fake APNs`);
	const apple = fakeApns(
		{ a: ports.a.apns, b: ports.b.apns, c: ports.c.apns },
		{ key: readFileSync(keyFile, "utf8"), cert: readFileSync(certFile, "utf8") },
	);
	const stubFor = (port: number) =>
		JSON.stringify({ sandbox: `https://127.0.0.1:${port}`, ca: certFile });

	let a = spawnChild("a", ports.a.node, ports.a.control, dirs.a, stubFor(ports.a.apns));
	let b = spawnChild("b", ports.b.node, ports.b.control, dirs.b, stubFor(ports.b.apns));
	let c = spawnChild("c", ports.c.node, ports.c.control, dirs.c, stubFor(ports.c.apns));
	const live = () => [a, b, c];

	const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
	const pem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;

	try {
		const [readyA, readyB, readyC] = await Promise.all([
			eventually(() => a.command<Ready>({ action: "ready" }), "node A"),
			eventually(() => b.command<Ready>({ action: "ready" }), "node B"),
			eventually(() => c.command<Ready>({ action: "ready" }), "node C"),
		]);
		const idA = readyA.identity.id;
		const idB = readyB.identity.id;
		const idC = readyC.identity.id;

		for (const leaf of [b, c]) {
			const invite = await a.command<{ origin?: string; code?: string; error?: string }>({
				action: "invite",
			});
			if (!invite.origin || !invite.code) throw new Error(`invite failed: ${invite.error}`);
			const joined = await leaf.command<{ ok: boolean; error?: string }>({
				action: "join",
				origin: invite.origin,
				code: invite.code,
			});
			if (!joined.ok) throw new Error(`${leaf.label} could not join A: ${joined.error}`);
		}
		await eventually(
			async () => {
				await Promise.all(live().map((child) => child.command({ action: "sync" })));
				for (const [child, others] of [
					[b, [idA, idC]],
					[c, [idA, idB]],
				] as const) {
					const peers = await child.command<Array<{ id: string }>>({ action: "peers" });
					for (const id of others) {
						if (!peers.some((peer) => peer.id === id)) {
							throw new Error(`${child.label} does not know ${id} yet`);
						}
					}
				}
				return true;
			},
			"the star closes into a mesh",
			45_000,
		);

		// --------------------------------------------- both halves reach the room
		const installed = await a.command<{ ok: boolean; error?: string }>({
			action: "key-install",
			pem,
		});
		if (!installed.ok) throw new Error(`the signing key should install: ${installed.error}`);
		const keyOnA = await a.command<PushCredentialStatus>({ action: "key-status" });
		if (!keyOnA.configured || keyOnA.keyFrom !== "here") {
			throw new Error("the desk the key was typed on should say so");
		}
		if (keyOnA.keyReplicated) throw new Error("a fresh signing key must not replicate unasked");

		const pairing = await a.command<{ deviceId: string }>({ action: "push-pair" });
		const registration = await a.command<PushRegistration>({
			action: "push-register",
			deviceId: pairing.deviceId,
			token: FIRST_TOKEN,
		});
		if (registration.ownerNode !== idA) throw new Error("the pairing desk should own the record");

		// An address without a key is half a feature, so prove the halves are
		// independent: the registration lands everywhere before the key does, and
		// a desk holding only the address cannot yet send.
		await eventually(
			async () => {
				await Promise.all(live().map((child) => child.command({ action: "sync" })));
				for (const child of [b, c]) {
					const rows = await child.command<PushRegistration[]>({ action: "push-list" });
					const row = rows.find((entry) => entry.id === registration.id);
					if (!row) throw new Error(`${child.label} cannot see the registration yet`);
					if (row.ownerNode !== idA) throw new Error("the owner desk did not survive the wire");
					if (!row.addressableHere) throw new Error(`${child.label} was not sealed an address`);
					if (JSON.stringify(row).includes(FIRST_TOKEN)) {
						throw new Error(`${child.label}'s room-level view carries the raw token`);
					}
					const status = await child.command<PushCredentialStatus>({ action: "key-status" });
					if (status.configured) throw new Error(`${child.label} signs with a key nobody shared`);
				}
				return true;
			},
			"the address reaches every desk, and a desk with no key still cannot send",
			45_000,
		);

		await a.command({ action: "key-replicate", replicate: true });
		await eventually(
			async () => {
				await Promise.all(live().map((child) => child.command({ action: "sync" })));
				for (const child of [b, c]) {
					const status = await child.command<PushCredentialStatus>({ action: "key-status" });
					if (!status.configured) throw new Error(`${child.label} has not been sealed the key`);
					if (status.keyFrom !== "room") throw new Error("a shared key should say where it came from");
					if (status.keyId !== "ABCD123456" || status.teamId !== "TEAM123456") {
						throw new Error("the key id and team id must travel with the key, or it is unusable");
					}
				}
				return true;
			},
			"the signing key reaches every desk, identifiers and all",
			45_000,
		);

		// ---------------------------------------------- one box per desk, exactly
		const boxes = await b.command<string[]>({ action: "push-boxes", id: registration.id });
		if (JSON.stringify(boxes) !== JSON.stringify([idB, idC].sort())) {
			throw new Error(`the record should carry a box per recipient desk, got ${boxes.join(", ")}`);
		}
		const cOwnBox = await c.command<{ opened: string | null }>({
			action: "push-open-box",
			id: registration.id,
			recipient: idC,
		});
		if (cOwnBox.opened !== FIRST_TOKEN) throw new Error("C could not open the box addressed to it");
		const cOnBsBox = await c.command<{ opened: string | null }>({
			action: "push-open-box",
			id: registration.id,
			recipient: idB,
		});
		if (cOnBsBox.opened !== null) throw new Error("C opened a box sealed to B — sealing is per desk");

		// ------------------------------------- one event, one notification
		// C's teammate finishes. C can reach the phone, and so can B, and so can
		// A — which is exactly the new problem. The room must produce one post.
		const owned = await postsFor(
			apple.posts,
			() => c.command({ action: "fire", personaId: "teammate-1" }),
			1,
			"an event on a third desk",
		);
		if (owned[0]?.desk !== "a") {
			throw new Error(`the owning desk should send while it is up, not ${owned[0]?.desk}`);
		}
		if (owned[0]?.token !== FIRST_TOKEN) throw new Error("the post carried the wrong address");

		// ----------------------------- the owner desk dies; the phone stays reachable
		a.process.kill();
		await a.process.exited;
		const reachOnB = await b.command<PushTarget[]>({ action: "push-fanout" });
		if (reachOnB.length !== 1 || reachOnB[0]?.token !== FIRST_TOKEN) {
			throw new Error("B lost the phone when its pairing desk went down — this is the whole point");
		}
		if (!(await b.command<PushCredentialStatus>({ action: "key-status" })).configured) {
			throw new Error("B lost the signing key when the desk that typed it went down");
		}

		// ------------------------- with the owner dead, one desk takes over — one
		// The stand-in is named by the rule, not by the race: owners first, then
		// everyone sealed a copy in id order. Both survivors run the same sort on
		// the same replicated bytes, so this is knowable from here.
		const standin = idB < idC ? "b" : "c";
		await eventually(
			async () => {
				const plan = await c.command<Record<string, string>>({ action: "elect" });
				const elected = plan[registration.id];
				if (elected === idA) throw new Error("C still believes the dead owner is up");
				if (!elected) throw new Error("C elected nobody at all");
				return true;
			},
			"the room notices the owner's link is down",
			30_000,
		);
		const takenOver = await postsFor(
			apple.posts,
			() => c.command({ action: "fire", personaId: "teammate-2" }),
			1,
			"an event with the pairing desk dead",
		);
		if (takenOver[0]?.desk !== standin) {
			throw new Error(
				`the takeover should be the desk the rule names (${standin}), not ${takenOver[0]?.desk}`,
			);
		}

		// A prune observed while the owner is dark stops the desk that saw it and
		// nobody else. That is the honest state, not a desk forgetting for the room.
		await b.command({ action: "push-dead", id: registration.id, generation: registration.generation });
		if ((await b.command<PushTarget[]>({ action: "push-fanout" })).length !== 0) {
			throw new Error("B kept posting to an address Apple told it was dead");
		}
		const onCWhileDark = await c.command<PushRegistration[]>({ action: "push-list" });
		if (onCWhileDark.find((row) => row.id === registration.id)?.addressableHere !== true) {
			throw new Error("C dropped an address on B's say-so; only the owner publishes a fact");
		}

		// ------------------------------------- the owner returns and the prune travels
		a = spawnChild("a", ports.a.node, ports.a.control, dirs.a, stubFor(ports.a.apns));
		await eventually(() => a.command<Ready>({ action: "ready" }), "node A restarted", 30_000);
		await eventually(
			async () => {
				await Promise.all(live().map((child) => child.command({ action: "sync" })));
				await Promise.all(live().map((child) => child.command({ action: "settle" })));
				for (const child of live()) {
					const row = (await child.command<PushRegistration[]>({ action: "push-list" })).find(
						(entry) => entry.id === registration.id,
					);
					if (!row?.dead) throw new Error(`${child.label} has not heard the prune`);
					if (row.addressableHere) throw new Error(`${child.label} still holds a dead address`);
				}
				return true;
			},
			"a prune observed on one desk becomes a fact the whole room honours",
			60_000,
		);

		// A prune B watched is silence for the whole room, not only for B.
		await postsFor(
			apple.posts,
			() => c.command({ action: "fire", personaId: "teammate-3" }),
			0,
			"an event after the address was pruned",
		);

		// --------------------------------- the phone relaunches with a fresh token
		const reborn = await a.command<PushRegistration>({
			action: "push-register",
			deviceId: pairing.deviceId,
			token: SECOND_TOKEN,
		});
		if (reborn.generation <= registration.generation) {
			throw new Error("a different token must be a new generation");
		}
		await eventually(
			async () => {
				await Promise.all(live().map((child) => child.command({ action: "sync" })));
				for (const child of [b, c]) {
					const fanout = await child.command<PushTarget[]>({ action: "push-fanout" });
					if (fanout[0]?.token !== SECOND_TOKEN) {
						throw new Error(`${child.label} is still holding the replaced token`);
					}
					if (fanout.length !== 1) throw new Error("one phone should be one fan-out target");
				}
				return true;
			},
			"the room converges on the token the phone actually has",
			45_000,
		);

		// The owner is back, so it is the sender again — and the fresh address is
		// the one that gets posted to, once.
		const reachable = await postsFor(
			apple.posts,
			() => c.command({ action: "fire", personaId: "teammate-4" }),
			1,
			"an event after the phone re-registered",
		);
		if (reachable[0]?.desk !== "a" || reachable[0]?.token !== SECOND_TOKEN) {
			throw new Error("the returned owner should send, to the address the phone actually has");
		}

		// A late report about the token that was replaced must not kill the new one.
		await b.command({
			action: "push-dead",
			id: registration.id,
			generation: registration.generation,
		});
		if ((await b.command<PushTarget[]>({ action: "push-fanout" }))[0]?.token !== SECOND_TOKEN) {
			throw new Error("a stale prune killed the token that replaced it");
		}

		// ------------------------------- unpairing, with one desk in the dark
		c.process.kill();
		await c.process.exited;
		await a.command({ action: "push-unpair", id: registration.id });
		await eventually(
			async () => {
				await a.command({ action: "settle" });
				const row = (await a.command<PushRegistration[]>({ action: "push-list" })).find(
					(entry) => entry.id === registration.id,
				);
				if (!row?.teardown) throw new Error("unpairing reported no teardown at all");
				if (!row.teardown.confirmed.includes(idB)) throw new Error("B, which is up, was not confirmed");
				if (!row.teardown.pending.includes(idC)) {
					throw new Error("a desk that is dark was reported as done");
				}
				return true;
			},
			"unpairing confirms the live desk and reports the dark one as pending",
			45_000,
		);
		if ((await b.command<PushTarget[]>({ action: "push-fanout" })).length !== 0) {
			throw new Error("B kept the address of an unpaired phone");
		}

		// C comes back, applies the withdrawal, and the owner completes only once
		// it has asked C and heard that C holds nothing.
		c = spawnChild("c", ports.c.node, ports.c.control, dirs.c, stubFor(ports.c.apns));
		await eventually(() => c.command<Ready>({ action: "ready" }), "node C restarted", 30_000);
		await eventually(
			async () => {
				await Promise.all(live().map((child) => child.command({ action: "sync" })));
				await Promise.all(live().map((child) => child.command({ action: "settle" })));
				if ((await c.command<PushTarget[]>({ action: "push-fanout" })).length !== 0) {
					throw new Error("the returning desk still holds its copy");
				}
				const onA = (await a.command<PushRegistration[]>({ action: "push-list" })).find(
					(entry) => entry.id === registration.id,
				);
				if (onA) throw new Error("a settled withdrawal should leave nothing behind");
				return true;
			},
			"the withdrawal completes when the dark desk returns",
			60_000,
		);

		console.log(
			"push plane: a phone registered on one desk is addressable from every desk, the signing key travels sealed beside it with its identifiers, both survive the pairing desk dying, a prune observed anywhere becomes a fact the owner publishes and the room honours, a stale prune cannot kill the token that replaced it, and unpairing reports the dark desk as pending until it returns",
		);
		console.log(
			"push senders: one event is one post at Apple — made by the owning desk while it is up, by the desk the rule names when the owner is dead, by nobody once the address is pruned, and by the returned owner to the address the phone actually has",
		);
	} finally {
		await Promise.all(
			live().map((child) => child.command({ action: "stop" }).catch(() => undefined)),
		);
		await Promise.all(live().map((child) => child.process.exited));
		apple.close();
		rmSync(root, { recursive: true, force: true });
	}
}

function spawnChild(
	label: string,
	nodePort: number,
	controlPort: number,
	dataDir: string,
	apnsStub: string,
): Child {
	const childProcess = Bun.spawn([process.execPath, fileURLToPath(import.meta.url)], {
		env: {
			...globalThis.process.env,
			TOAD_PUSH_CHILD: label,
			TOAD_NODE_PORT: String(nodePort),
			TOAD_PUSH_CONTROL_PORT: String(controlPort),
			TOAD_DATA_DIR: dataDir,
			TOAD_APNS_HOST_STUB: apnsStub,
		},
		stdout: "inherit",
		stderr: "inherit",
	});
	return {
		label,
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

async function eventually<T>(run: () => Promise<T>, label: string, timeoutMs = 12_000): Promise<T> {
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
			await new Promise((resolve) => setTimeout(resolve, 250));
		}
	}
}
