/**
 * Three isolated desktops proving the node plane is confidential, pinned, and
 * still willing to talk to a desk that has not upgraded:
 *
 * - A and B come up on TLS and pair. The certificate fingerprint rides inside
 *   the signed admission on both sides, and it is the fingerprint of the
 *   certificate each desk is actually serving — not a hopeful copy of one.
 * - Their NodeLink is wss, and it survives a real heartbeat cycle rather than
 *   merely reaching "up" once.
 * - A desk presenting the WRONG certificate for a pinned fingerprint is
 *   refused, on both the request path and the socket path. The same dial with
 *   the right pin succeeds a line later, so the refusal is the pin and not the
 *   weather.
 * - B rotates its key and announces it over the authenticated link. A re-pins
 *   from the announcement alone and the link comes back — no human, no
 *   re-pairing.
 * - C never had TLS at all. It pairs, it is admitted with no pin, and the room
 *   closes to a full mesh across the mixed fleet.
 *
 *   bun scripts/verify-node-tls.ts
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

type JsonRecord = Record<string, unknown>;

const CHILD = process.env.TOAD_NODE_TLS_CHILD;

if (CHILD) {
	await runChild(CHILD);
} else {
	await runParent();
}

async function runChild(label: string): Promise<void> {
	const nodePort = Number(process.env.TOAD_NODE_PORT);
	const controlPort = Number(process.env.TOAD_NODE_TLS_CONTROL_PORT);
	if (!nodePort || !controlPort) throw new Error("node and control ports are required");

	const fleet = await import("../src/bun/fleet/fleet");
	const wire = await import("../src/bun/fleet/wire");
	const membership = await import("../src/bun/node/membership");
	const identity = await import("../src/bun/node/identity");
	const nodeServer = await import("../src/bun/node/server");
	const tls = await import("../src/bun/node/tls");
	const dial = await import("../src/bun/node/dial");

	const handlers: Record<string, (params: unknown) => Promise<unknown>> = {
		listPersonas: async () => [],
		getSessionInfo: async (params) => ({
			personaId: (params as { personaId?: string })?.personaId ?? "",
			state: "stopped",
		}),
	};
	const resolve = (method: string) => handlers[method];

	fleet.initFleet({
		createTeammate: (draft) => ({ personaId: `${label}-created`, name: draft.name }),
		readTranscript: () => null,
		readThread: () => null,
		/* No peer thread is read here, so nothing moves. Supplied because
		   `Deps` requires it: a harness that does not compile is a harness
		   that has stopped tracking the contract it is proving. */
		threadRead: () => 0,
		deliver: async () => ({ ok: false, detail: "not exercised" }),
		httpOrigin: () => null,
		nodeOrigin: nodeServer.nodeOrigin,
	});
	wire.initPeerWires({ send: () => {}, publishPersonas: () => {}, resolve });
	nodeServer.startNodeServer(resolve, nodePort, wire.nodeLinkServerHooks);

	/**
	 * One dial at one origin with one chosen certificate, over both transports
	 * the node plane uses. "pinned" is what production does; "self" hands the
	 * dialer this desk's own certificate, which is a perfectly valid
	 * certificate belonging to the wrong machine — the exact shape of the
	 * attack a pin exists to stop.
	 */
	async function probe(origin: string, peerId: string, mode: "pinned" | "self") {
		const pin =
			mode === "pinned"
				? fleet.pinFor(peerId)
				: (() => {
						const pem = tls.localCertPem();
						return pem ? { fingerprint: tls.certFingerprint(pem), cert: pem } : null;
					})();
		if (!pin) return { pin: false, fetch: "no pin", socket: "no pin" };

		let fetched: string;
		try {
			const response = await dial.nodeFetch(
				new URL("/node/info", origin),
				{ signal: AbortSignal.timeout(5_000) },
				pin,
			);
			fetched = response.ok ? "ok" : `status ${response.status}`;
		} catch (error) {
			fetched = `refused: ${error instanceof Error ? error.message : String(error)}`;
		}

		/* The socket carries a deliberately invalid bearer, so the question is
		 * never "did the link come up" — it is "how far did we get". A wrong
		 * pin dies in the TLS handshake; a right pin gets all the way to the
		 * server turning the bogus token away, which is the proof wanted. */
		const socket = await new Promise<string>((done) => {
			let settled = false;
			const finish = (value: string) => {
				if (!settled) {
					settled = true;
					done(value);
				}
			};
			let ws: WebSocket;
			try {
				ws = new WebSocket(
					`${origin.replace(/^http/, "ws")}/node/link?token=probe`,
					{ tls: tls.pinnedTlsOptions(pin) } as never,
				);
			} catch (error) {
				finish(`refused: ${error instanceof Error ? error.message : String(error)}`);
				return;
			}
			const timer = setTimeout(() => finish("timeout"), 5_000);
			ws.onopen = () => {
				clearTimeout(timer);
				ws.close();
				finish("open");
			};
			ws.onerror = (event) => {
				clearTimeout(timer);
				const message = (event as { message?: string })?.message ?? "socket error";
				/* The one distinction that matters: a failure inside the TLS
				 * handshake is the pin refusing a certificate, while any failure
				 * after it is the application refusing a token — which means the
				 * certificate was accepted. */
				finish(message.includes("TLS") ? `refused: ${message}` : `tls-ok: ${message}`);
			};
			ws.onclose = () => {
				clearTimeout(timer);
				finish("tls-ok: closed");
			};
		});
		return { pin: true, fetch: fetched, socket };
	}

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
							result: {
								identity: identity.nodeIdentity(),
								origin: nodeServer.nodeOrigin(),
								certFingerprint: nodeServer.nodeCertFingerprint(),
							},
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
					case "peers":
						return Response.json({ ok: true, result: fleet.listFleetPeers() });
					case "admissions":
						return Response.json({
							ok: true,
							result: membership.listAdmittedNodes().map((row) => ({
								id: row.node.id,
								origin: row.origin,
								certFingerprint: row.certFingerprint ?? null,
							})),
						});
					case "links":
						return Response.json({ ok: true, result: wire.nodeLinkSnapshot() });
					case "probe":
						return Response.json({
							ok: true,
							result: await probe(
								String(input.origin),
								String(input.peerId),
								input.mode === "self" ? "self" : "pinned",
							),
						});
					case "rotate":
						return Response.json({ ok: true, result: await wire.rotateNodeCertificate() });
					case "sync":
						await wire.syncPeerWires();
						return Response.json({ ok: true, result: { synced: true } });
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

type Ready = {
	identity: { id: string; name: string };
	origin: string;
	certFingerprint: string | null;
};
type Peer = { id: string; origin: string };
type Admission = { id: string; origin: string; certFingerprint: string | null };
type Link = { nodeId: string; up: boolean };
type Probe = { pin: boolean; fetch: string; socket: string };

async function runParent(): Promise<void> {
	const root = mkdtempSync(join(tmpdir(), "toad-node-tls-"));
	const base = 50_500 + Math.floor(Math.random() * 300);
	const children: Child[] = [];

	try {
		const a = spawnChild("a", base, base + 10, join(root, "a"), true);
		const b = spawnChild("b", base + 1, base + 11, join(root, "b"), true);
		// The desk that never upgraded. Same code, plain listener — which is
		// what a mixed fleet looks like from the moment this ships.
		const c = spawnChild("c", base + 2, base + 12, join(root, "c"), false);
		children.push(a, b, c);

		const [readyA, readyB, readyC] = await Promise.all([
			eventually(() => a.command<Ready>({ action: "ready" }), "node A"),
			eventually(() => b.command<Ready>({ action: "ready" }), "node B"),
			eventually(() => c.command<Ready>({ action: "ready" }), "node C"),
		]);

		for (const [ready, label] of [
			[readyA, "A"],
			[readyB, "B"],
		] as const) {
			if (!ready.origin.startsWith("https://")) {
				throw new Error(`${label} did not come up on TLS: ${ready.origin}`);
			}
			if (!/^[a-f0-9]{64}$/.test(ready.certFingerprint ?? "")) {
				throw new Error(`${label} serves TLS with no fingerprint to pin`);
			}
		}
		if (!readyC.origin.startsWith("http://") || readyC.certFingerprint !== null) {
			throw new Error(`C should have stayed plain: ${readyC.origin}`);
		}

		await pair(a, b);

		// The pin is the peer's real certificate, and it is inside the signed
		// admission on both sides — the whole trust story in one assertion.
		const admissionsA = await a.command<Admission[]>({ action: "admissions" });
		const admissionsB = await b.command<Admission[]>({ action: "admissions" });
		const pinnedB = admissionsA.find((row) => row.id === readyB.identity.id);
		const pinnedA = admissionsB.find((row) => row.id === readyA.identity.id);
		if (pinnedB?.certFingerprint !== readyB.certFingerprint) {
			throw new Error("A's admission of B does not pin B's certificate");
		}
		if (pinnedA?.certFingerprint !== readyA.certFingerprint) {
			throw new Error("B's admission of A does not pin A's certificate");
		}
		if (!pinnedB.origin.startsWith("https://")) {
			throw new Error("A admitted B on a plain origin");
		}

		await eventually(
			() => linkUp(a, readyB.identity.id),
			"the A-B link comes up over wss",
			30_000,
		);

		// Up once is not up. A real heartbeat cycle must pass underneath it.
		await new Promise((resolve) => setTimeout(resolve, 9_000));
		await linkUp(a, readyB.identity.id);
		await linkUp(b, readyA.identity.id);

		// The refusal, and its control. Same origin, same code path, one
		// difference: whose certificate the dialer was told to expect.
		const wrong = await a.command<Probe>({
			action: "probe",
			origin: readyB.origin,
			peerId: readyB.identity.id,
			mode: "self",
		});
		if (!wrong.fetch.startsWith("refused")) {
			throw new Error(`a wrong certificate was accepted on the request path: ${wrong.fetch}`);
		}
		if (!wrong.socket.startsWith("refused")) {
			throw new Error(`a wrong certificate was accepted on the socket path: ${wrong.socket}`);
		}
		const right = await a.command<Probe>({
			action: "probe",
			origin: readyB.origin,
			peerId: readyB.identity.id,
			mode: "pinned",
		});
		if (right.fetch !== "ok") throw new Error(`the pinned request path failed: ${right.fetch}`);
		if (!right.socket.startsWith("tls-ok")) {
			throw new Error(`the pinned socket path failed: ${right.socket}`);
		}

		// B replaces its key and says so on the link. Nobody types anything.
		const rotated = await b.command<{ rotated: boolean; announced: number }>({ action: "rotate" });
		if (!rotated.rotated) throw new Error("B could not rotate its certificate");
		if (rotated.announced < 1) throw new Error("B rotated without telling anyone");
		const readyBAfter = await eventually(
			() => b.command<Ready>({ action: "ready" }),
			"B comes back on its new certificate",
			20_000,
		);
		if (readyBAfter.certFingerprint === readyB.certFingerprint) {
			throw new Error("B's rotation did not change the certificate it serves");
		}
		await eventually(
			async () => {
				await a.command({ action: "sync" });
				const rows = await a.command<Admission[]>({ action: "admissions" });
				const pin = rows.find((row) => row.id === readyB.identity.id)?.certFingerprint;
				if (pin !== readyBAfter.certFingerprint) {
					throw new Error("A has not re-pinned B from the announcement");
				}
				return linkUp(a, readyB.identity.id);
			},
			"A re-pins B from the signed announcement and the link returns",
			45_000,
		);

		// The mixed fleet: the plain desk joins, is admitted with no pin, and
		// the room still closes all the way round.
		await pair(a, c);
		const withC = await a.command<Admission[]>({ action: "admissions" });
		const rowC = withC.find((row) => row.id === readyC.identity.id);
		if (!rowC) throw new Error("A did not admit the plain desk");
		if (rowC.certFingerprint !== null) throw new Error("A invented a pin for a plain desk");
		if (!rowC.origin.startsWith("http://")) throw new Error("A admitted C on the wrong scheme");

		await eventually(
			async () => {
				await Promise.all([a.command({ action: "sync" }), b.command({ action: "sync" })]);
				const desks: Array<[Child, string, string]> = [
					[a, readyB.identity.id, readyC.identity.id],
					[b, readyA.identity.id, readyC.identity.id],
					[c, readyA.identity.id, readyB.identity.id],
				];
				for (const [child, first, second] of desks) {
					const peers = await child.command<Peer[]>({ action: "peers" });
					for (const id of [first, second]) {
						if (!peers.some((peer) => peer.id === id)) {
							throw new Error(`${child.label} has not met ${id.slice(-6)} yet`);
						}
					}
					await linkUp(child, first);
					await linkUp(child, second);
				}
				return true;
			},
			"the mixed fleet closes into a full mesh with every link up",
			60_000,
		);

		/* The 0.2.11-class migration: two desks paired in the plain era both
		 * upgrade, every stored origin still says http, every listener now
		 * refuses plaintext, and no live link remains to announce anything
		 * over. The probe must heal the pair without a human. */
		const dDir = join(root, "d");
		const eDir = join(root, "e");
		let d = spawnChild("d", base + 6, base + 16, dDir, false);
		let e = spawnChild("e", base + 7, base + 17, eDir, false);
		children.push(d, e);
		const [readyD, readyE] = await Promise.all([
			eventually(() => d.command<Ready>({ action: "ready" }), "node D"),
			eventually(() => e.command<Ready>({ action: "ready" }), "node E"),
		]);
		if (readyD.origin.startsWith("https://")) throw new Error("D was meant to start plain");
		{
			const invite = await d.command<{ origin?: string; code?: string; error?: string }>({
				action: "invite",
			});
			if (!invite.origin || !invite.code) throw new Error(`plain-era invite failed: ${invite.error}`);
			const joined = await e.command<{ ok: boolean; error?: string }>({
				action: "join",
				origin: invite.origin,
				code: invite.code,
			});
			if (!joined.ok) throw new Error(`plain-era join failed: ${joined.error}`);
		}
		await eventually(async () => linkUp(await refresh(e), readyD.identity.id), "plain-era pair links", 30_000);

		// Both desks upgrade: same data, same ports, TLS listeners now.
		await Promise.all([d, e].map((child) => child.command({ action: "stop" }).catch(() => undefined)));
		await Promise.all([d.process.exited, e.process.exited]);
		d = spawnChild("d", base + 6, base + 16, dDir, true);
		e = spawnChild("e", base + 7, base + 17, eDir, true);
		children.push(d, e);
		await Promise.all([
			eventually(() => d.command<Ready>({ action: "ready" }), "node D after upgrade"),
			eventually(() => e.command<Ready>({ action: "ready" }), "node E after upgrade"),
		]);

		await eventually(
			async () => {
				await Promise.all([d.command({ action: "sync" }), e.command({ action: "sync" })]);
				for (const [child, other] of [
					[d, readyE.identity.id] as const,
					[e, readyD.identity.id] as const,
				]) {
					const peers = await child.command<Peer[]>({ action: "peers" });
					const row = peers.find((peer) => peer.id === other);
					if (!row) throw new Error(`${child.label} lost its peer in the upgrade`);
					if (!row.origin.startsWith("https://")) {
						throw new Error(`${child.label} still dials ${other.slice(-6)} plain`);
					}
					const admissions = await child.command<Array<{ id: string; certFingerprint: string | null }>>({
						action: "admissions",
					});
					if (!admissions.find((entry) => entry.id === other)?.certFingerprint) {
						throw new Error(`${child.label} holds no pin for ${other.slice(-6)}`);
					}
					await linkUp(child, other);
				}
				return true;
			},
			"a plain-era pair heals itself after both desks upgrade",
			90_000,
		);

		console.log(
			"node-tls: TLS by default, pins ride the signed admission, a wrong certificate is refused on both paths, rotation re-pins itself, a plain desk still converges, and a plain-era pair upgrades without a human",
		);
	} finally {
		await Promise.all(children.map((child) => child.command({ action: "stop" }).catch(() => undefined)));
		await Promise.all(children.map((child) => child.process.exited));
		rmSync(root, { recursive: true, force: true });
	}
}

async function pair(inviter: Child, joiner: Child): Promise<void> {
	const invite = await inviter.command<{ origin?: string; code?: string; error?: string }>({
		action: "invite",
	});
	if (!invite.origin || !invite.code) throw new Error(`invite failed: ${invite.error}`);
	const joined = await joiner.command<{ ok: boolean; error?: string }>({
		action: "join",
		origin: invite.origin,
		code: invite.code,
	});
	if (!joined.ok) {
		throw new Error(`${joiner.label} could not join ${inviter.label}: ${joined.error}`);
	}
}

async function refresh(child: Child): Promise<Child> {
	return child;
}

async function linkUp(child: Child, nodeId: string): Promise<true> {
	const links = await child.command<Link[]>({ action: "links" });
	if (!links.find((link) => link.nodeId === nodeId)?.up) {
		throw new Error(`${child.label} has no live link to ${nodeId.slice(-6)}`);
	}
	return true;
}

function spawnChild(
	label: string,
	nodePort: number,
	controlPort: number,
	dataDir: string,
	tls: boolean,
): Child {
	const childProcess = Bun.spawn([process.execPath, fileURLToPath(import.meta.url)], {
		env: {
			...globalThis.process.env,
			TOAD_NODE_TLS_CHILD: label,
			TOAD_NODE_PORT: String(nodePort),
			TOAD_NODE_TLS_CONTROL_PORT: String(controlPort),
			TOAD_DATA_DIR: dataDir,
			TOAD_NODE_TLS: tls ? "1" : "0",
			// A heartbeat the harness can actually sit through.
			TOAD_NODE_HEARTBEAT_MS: "2000",
			TOAD_DISABLE_MDNS: "1",
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
