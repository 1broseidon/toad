/**
 * Three isolated desktops proving that membership is room policy, not a
 * per-desk opinion:
 *
 * - a star (A-B, A-C) closes into a mesh, and the admissions gossip as
 *   signed membership facts
 * - A revokes C — and C dies EVERYWHERE: B tears it down (peer row,
 *   admission, replicated records) on gossip alone, having never been told
 *   directly
 * - the ban outranks the healing: the mesh closure must NOT re-introduce C,
 *   no matter how many sweeps run
 * - a fresh admission supersedes the ban: A re-invites C and the room
 *   re-closes, B included, exactly as if C were new
 *
 *   bun scripts/verify-membership.ts
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

type JsonRecord = Record<string, unknown>;

const CHILD = process.env.TOAD_MEMBERSHIP_CHILD;

if (CHILD) {
	await runChild(CHILD);
} else {
	await runParent();
}

async function runChild(label: string): Promise<void> {
	const nodePort = Number(process.env.TOAD_NODE_PORT);
	const controlPort = Number(process.env.TOAD_MEMBERSHIP_CONTROL_PORT);
	if (!nodePort || !controlPort) throw new Error("node and control ports are required");

	const fleet = await import("../src/bun/fleet/fleet");
	const wire = await import("../src/bun/fleet/wire");
	const facts = await import("../src/bun/node/facts");
	const membership = await import("../src/bun/node/membership");
	const identity = await import("../src/bun/node/identity");
	const nodeServer = await import("../src/bun/node/server");
	const records = await import("../src/bun/store/records");

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
		deliver: async () => ({ ok: false, detail: "not exercised" }),
		httpOrigin: () => null,
		nodeOrigin: nodeServer.nodeOrigin,
	});
	wire.initPeerWires({
		send: () => {},
		publishPersonas: () => {},
		resolve,
	});
	nodeServer.startNodeServer(resolve, nodePort, wire.nodeLinkServerHooks);

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
					case "revoke": {
						const revoked = fleet.revokeFleetPeer(String(input.id));
						await wire.syncPeerWires();
						return Response.json({ ok: true, result: { revoked } });
					}
					case "seed-persona": {
						records.putLocal("persona", String(input.id), {
							replicated: { name: String(input.name ?? input.id) },
						});
						return Response.json({ ok: true, result: { seeded: true } });
					}
					case "records":
						return Response.json({
							ok: true,
							result: records
								.listRecords("persona")
								.map((row) => ({ id: row.id, ownerNode: row.ownerNode })),
						});
					case "peers":
						return Response.json({ ok: true, result: fleet.listFleetPeers() });
					case "admissions":
						return Response.json({ ok: true, result: membership.listAdmittedNodes() });
					case "membership":
						return Response.json({
							ok: true,
							result: {
								facts: facts.listMembershipFacts().map((fact) => ({
									subject: fact.subject.id,
									action: fact.action,
									assertedBy: fact.asserter.id,
								})),
								members: [...facts.effectiveMembers()],
							},
						});
					case "links":
						return Response.json({ ok: true, result: wire.nodeLinkSnapshot() });
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

type Ready = { identity: { id: string; name: string }; origin: string };
type Peer = { id: string };
type Link = { nodeId: string; up: boolean };

async function runParent(): Promise<void> {
	const root = mkdtempSync(join(tmpdir(), "toad-membership-"));
	const base = 50_100 + Math.floor(Math.random() * 300);
	const children: Child[] = [];

	try {
		const a = spawnChild("a", base, base + 10, join(root, "a"));
		const b = spawnChild("b", base + 1, base + 11, join(root, "b"));
		const c = spawnChild("c", base + 2, base + 12, join(root, "c"));
		children.push(a, b, c);

		const [, , readyC] = await Promise.all([
			eventually(() => a.command<Ready>({ action: "ready" }), "node A"),
			eventually(() => b.command<Ready>({ action: "ready" }), "node B"),
			eventually(() => c.command<Ready>({ action: "ready" }), "node C"),
		]);

		// C owns a persona the others replicate; its later disappearance from B
		// is what proves the purge is part of the room-wide teardown.
		await c.command({ action: "seed-persona", id: "c-persona", name: "Biscuit" });

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
				await a.command({ action: "sync" });
				const peersB = await b.command<Peer[]>({ action: "peers" });
				if (!peersB.some((peer) => peer.id === readyC.identity.id)) {
					throw new Error("mesh has not closed B-C yet");
				}
				const recordsB = await b.command<Array<{ ownerNode: string }>>({ action: "records" });
				if (!recordsB.some((row) => row.ownerNode === readyC.identity.id)) {
					throw new Error("C's persona has not replicated to B yet");
				}
				return true;
			},
			"star closes into a mesh and C's records reach B",
			30_000,
		);

		// The room's word reaches B by gossip: it learns the admissions it did
		// not make itself.
		await eventually(
			async () => {
				const view = await b.command<{ members: string[] }>({ action: "membership" });
				if (!view.members.includes(readyC.identity.id)) {
					throw new Error("B's membership view does not include C yet");
				}
				return true;
			},
			"membership facts gossip to B",
			15_000,
		);

		// A removes C. Nothing talks to B about it except the gossip.
		await a.command({ action: "revoke", id: readyC.identity.id });

		await eventually(
			async () => {
				const [peersB, admissionsB, recordsB] = await Promise.all([
					b.command<Peer[]>({ action: "peers" }),
					b.command<Array<{ node: { id: string } }>>({ action: "admissions" }),
					b.command<Array<{ ownerNode: string }>>({ action: "records" }),
				]);
				if (peersB.some((peer) => peer.id === readyC.identity.id)) {
					throw new Error("B still lists C as a peer");
				}
				if (admissionsB.some((row) => row.node.id === readyC.identity.id)) {
					throw new Error("B still holds C's admission");
				}
				if (recordsB.some((row) => row.ownerNode === readyC.identity.id)) {
					throw new Error("C's records still live on B");
				}
				return true;
			},
			"revocation on A tears C down on B, records and all",
			30_000,
		);

		// The ban must outlast the healing: sweep repeatedly and confirm the
		// mesh closure never resurrects C on either survivor.
		for (let round = 0; round < 6; round++) {
			await Promise.all([a.command({ action: "sync" }), b.command({ action: "sync" })]);
			await new Promise((resolve) => setTimeout(resolve, 700));
		}
		const peersAfter = await Promise.all([
			a.command<Peer[]>({ action: "peers" }),
			b.command<Peer[]>({ action: "peers" }),
		]);
		for (const peers of peersAfter) {
			if (peers.some((peer) => peer.id === readyC.identity.id)) {
				throw new Error("the mesh closure resurrected a revoked node");
			}
		}

		// A fresh admission supersedes the ban — C returns everywhere, once.
		const invite = await a.command<{ origin?: string; code?: string; error?: string }>({
			action: "invite",
		});
		if (!invite.origin || !invite.code) throw new Error(`re-invite failed: ${invite.error}`);
		const rejoined = await c.command<{ ok: boolean; error?: string }>({
			action: "join",
			origin: invite.origin,
			code: invite.code,
		});
		if (!rejoined.ok) throw new Error(`C could not rejoin: ${rejoined.error}`);

		try {
			await eventually(
				async () => {
					await a.command({ action: "sync" });
					const peersB = await b.command<Peer[]>({ action: "peers" });
					const matches = peersB.filter((peer) => peer.id === readyC.identity.id);
					if (matches.length !== 1) {
						throw new Error(`B lists C ${matches.length} times after re-admission`);
					}
					const links = await b.command<Link[]>({ action: "links" });
					if (!links.find((link) => link.nodeId === readyC.identity.id)?.up) {
						throw new Error("B-C link is not up after re-admission");
					}
					return true;
				},
				"re-admission supersedes the ban and the room re-closes",
				45_000,
			);
		} catch (error) {
			for (const child of [a, b, c]) {
				const [peers, links, view] = await Promise.all([
					child.command<Peer[]>({ action: "peers" }).catch(() => "?"),
					child.command<Link[]>({ action: "links" }).catch(() => "?"),
					child.command({ action: "membership" }).catch(() => "?"),
				]);
				console.error(`[dump ${child.label}] peers=${JSON.stringify(peers)}`);
				console.error(`[dump ${child.label}] links=${JSON.stringify(links)}`);
				console.error(`[dump ${child.label}] membership=${JSON.stringify(view)}`);
			}
			throw error;
		}

		console.log(
			"membership: facts gossip, revocation tears down everywhere, bans outrank healing, re-admission supersedes — no ghosts",
		);
	} finally {
		await Promise.all(children.map((child) => child.command({ action: "stop" }).catch(() => undefined)));
		await Promise.all(children.map((child) => child.process.exited));
		rmSync(root, { recursive: true, force: true });
	}
}

function spawnChild(label: string, nodePort: number, controlPort: number, dataDir: string): Child {
	const childProcess = Bun.spawn([process.execPath, fileURLToPath(import.meta.url)], {
		env: {
			...globalThis.process.env,
			TOAD_MEMBERSHIP_CHILD: label,
			TOAD_NODE_PORT: String(nodePort),
			TOAD_MEMBERSHIP_CONTROL_PORT: String(controlPort),
			TOAD_DATA_DIR: dataDir,
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
				signal: AbortSignal.timeout(5_000),
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
