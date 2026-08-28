/**
 * Three isolated desktops proving that a star closes into a mesh:
 *
 * - A pairs with B, A pairs with C — a star, A at the centre
 * - A officiates: B and C are introduced over A's authenticated links,
 *   claim /fleet/pair directly from each other, and land their own
 *   pairwise admission with end-to-end identity proofs
 * - every pair holds one authenticated NodeLink, whichever side dialed
 * - a dropped link comes back even when the smaller id cannot dial
 *   (dial-until-win: either side's socket may carry the pair)
 *
 *   bun scripts/verify-mesh-closure.ts
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

type JsonRecord = Record<string, unknown>;

const CHILD = process.env.TOAD_MESH_CLOSURE_CHILD;

if (CHILD) {
	await runChild(CHILD);
} else {
	await runParent();
}

async function runChild(label: string): Promise<void> {
	const nodePort = Number(process.env.TOAD_NODE_PORT);
	const controlPort = Number(process.env.TOAD_MESH_CLOSURE_CONTROL_PORT);
	if (!nodePort || !controlPort) throw new Error("node and control ports are required");

	const fleet = await import("../src/bun/fleet/fleet");
	const wire = await import("../src/bun/fleet/wire");
	const membership = await import("../src/bun/node/membership");
	const identity = await import("../src/bun/node/identity");
	const nodeServer = await import("../src/bun/node/server");

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
					case "peers":
						return Response.json({ ok: true, result: fleet.listFleetPeers() });
					case "admissions":
						return Response.json({ ok: true, result: membership.listAdmittedNodes() });
					case "links":
						return Response.json({ ok: true, result: wire.nodeLinkSnapshot() });
					case "sync":
						await wire.syncPeerWires();
						return Response.json({ ok: true, result: { synced: true } });
					case "drop-link":
						nodeServer.closeNodePeer(String(input.id));
						return Response.json({ ok: true, result: { dropped: true } });
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
type Link = {
	nodeId: string;
	dialer: boolean;
	up: boolean;
	direction: "incoming" | "outgoing" | null;
};

async function runParent(): Promise<void> {
	const root = mkdtempSync(join(tmpdir(), "toad-mesh-closure-"));
	const base = 49_600 + Math.floor(Math.random() * 300);
	const children: Child[] = [];

	try {
		const a = spawnChild("a", base, base + 10, join(root, "a"));
		const b = spawnChild("b", base + 1, base + 11, join(root, "b"));
		const c = spawnChild("c", base + 2, base + 12, join(root, "c"));
		children.push(a, b, c);

		const [, readyB, readyC] = await Promise.all([
			eventually(() => a.command<Ready>({ action: "ready" }), "node A"),
			eventually(() => b.command<Ready>({ action: "ready" }), "node B"),
			eventually(() => c.command<Ready>({ action: "ready" }), "node C"),
		]);

		// The star: A-B and A-C by explicit invite. B and C never exchange codes.
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
		await a.command({ action: "sync" });

		// Closure: A introduces B and C; they pair directly and admit each other.
		await eventually(
			async () => {
				await a.command({ action: "sync" });
				const [peersB, peersC] = await Promise.all([
					b.command<Peer[]>({ action: "peers" }),
					c.command<Peer[]>({ action: "peers" }),
				]);
				if (!peersB.some((peer) => peer.id === readyC.identity.id)) {
					throw new Error("B does not list C yet");
				}
				if (!peersC.some((peer) => peer.id === readyB.identity.id)) {
					throw new Error("C does not list B yet");
				}
				return true;
			},
			"mesh closure: B and C pair through A's introduction",
			30_000,
		);

		const [admissionsB, admissionsC] = await Promise.all([
			b.command<Array<{ node: { id: string } }>>({ action: "admissions" }),
			c.command<Array<{ node: { id: string } }>>({ action: "admissions" }),
		]);
		if (!admissionsB.some((row) => row.node.id === readyC.identity.id)) {
			throw new Error("B holds no signed admission for C");
		}
		if (!admissionsC.some((row) => row.node.id === readyB.identity.id)) {
			throw new Error("C holds no signed admission for B");
		}

		// Every pair carries one authenticated link: 2 per node, all up.
		await eventually(
			async () => {
				await Promise.all([b.command({ action: "sync" }), c.command({ action: "sync" })]);
				for (const child of [a, b, c]) {
					const links = await child.command<Link[]>({ action: "links" });
					const ups = links.filter((link) => link.up);
					if (ups.length !== 2) {
						throw new Error(`${child.label} has ${ups.length}/2 links up`);
					}
				}
				return true;
			},
			"full pairwise mesh of authenticated links",
			30_000,
		);

		// Dial-until-win: sever B-C and confirm it returns regardless of which
		// side can dial. Both retry loops run now, so the pair must come back.
		await b.command({ action: "drop-link", id: readyC.identity.id });
		await eventually(
			async () => {
				const links = await b.command<Link[]>({ action: "links" });
				const toC = links.find((link) => link.nodeId === readyC.identity.id);
				if (!toC?.up) throw new Error("B-C link has not reconnected");
				return true;
			},
			"severed pair reconnects",
			30_000,
		);

		console.log(
			"mesh-closure: star of three converged to a full pairwise mesh — introductions, signed admissions, authenticated links, reconnect",
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
			TOAD_MESH_CLOSURE_CHILD: label,
			TOAD_NODE_PORT: String(nodePort),
			TOAD_MESH_CLOSURE_CONTROL_PORT: String(controlPort),
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
