/**
 * Two isolated desktops proving the first node-plane slice:
 *
 * - mDNS discovers both node listeners without granting trust
 * - a signed nearby request waits for Accept or Deny
 * - acceptance writes signed membership and opens the direct peer wire
 * - the address/token path reaches the same paired state
 *
 *   bun hack/verify-node-admission.ts
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

type JsonRecord = Record<string, unknown>;

const CHILD = process.env.TOAD_NODE_CHILD;

if (CHILD) {
	await runChild(CHILD);
} else {
	await runParent();
}

async function runChild(label: string): Promise<void> {
	const nodePort = Number(process.env.TOAD_NODE_PORT);
	const controlPort = Number(process.env.TOAD_NODE_CONTROL_PORT);
	if (!nodePort || !controlPort) throw new Error("node and control ports are required");

	const fleet = await import("../src/bun/fleet/fleet");
	const wire = await import("../src/bun/fleet/wire");
	const admission = await import("../src/bun/node/admission");
	const discovery = await import("../src/bun/node/discovery");
	const identity = await import("../src/bun/node/identity");
	const membership = await import("../src/bun/node/membership");
	const nodeServer = await import("../src/bun/node/server");

	const calls: string[] = [];
	const handlers: Record<string, (params: unknown) => Promise<unknown>> = {
		listPersonas: async () => {
			calls.push("listPersonas");
			return [];
		},
	};
	const resolve = (method: string) => handlers[method];

	fleet.initFleet({
		stateOf: () => "stopped",
		createTeammate: (draft) => ({ personaId: `${label}-created`, name: draft.name }),
		readTranscript: () => null,
		readThread: () => null,
		deliver: async () => ({ ok: false, detail: "not exercised" }),
		httpOrigin: () => null,
		nodeOrigin: nodeServer.nodeOrigin,
	});
	nodeServer.startNodeServer(resolve, nodePort);
	discovery.startNodeDiscovery(nodePort);
	wire.initPeerWires({ send: () => {}, publishPersonas: () => {} });

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
					case "nearby":
						return Response.json({ ok: true, result: discovery.listNearbyNodes() });
					case "request":
						return Response.json({
							ok: true,
							result: await admission.requestNearbyNode({
								nodeId: String(input.nodeId),
								name: String(input.name),
								origin: String(input.origin),
							}),
						});
					case "incoming":
						return Response.json({ ok: true, result: admission.listIncomingNodeRequests() });
					case "outgoing":
						return Response.json({ ok: true, result: await admission.listOutgoingNodeRequests() });
					case "decide": {
						const result = await admission.decideNodeRequest(
							String(input.id),
							input.decision === "deny" ? "deny" : "accept",
						);
						if (result.ok && input.decision !== "deny") await wire.syncPeerWires();
						return Response.json({ ok: true, result });
					}
					case "peers":
						return Response.json({ ok: true, result: fleet.listFleetPeers() });
					case "admissions":
						return Response.json({ ok: true, result: membership.listAdmittedNodes() });
					case "calls":
						return Response.json({ ok: true, result: [...calls] });
					case "revoke": {
						const revoked = fleet.revokeFleetPeer(String(input.id));
						await wire.syncPeerWires();
						return Response.json({ ok: true, result: { revoked } });
					}
					case "invite":
						return Response.json({ ok: true, result: admission.createNodeInvite() });
					case "join": {
						const result = await admission.joinNodeInvite(String(input.origin), String(input.code));
						if (result.ok) await wire.syncPeerWires();
						return Response.json({ ok: true, result });
					}
					case "stop":
						setTimeout(() => {
							discovery.stopNodeDiscovery();
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
	controlPort: number;
	process: ReturnType<typeof Bun.spawn>;
	command<T>(input: JsonRecord): Promise<T>;
};

async function runParent(): Promise<void> {
	const root = mkdtempSync(join(tmpdir(), "toad-node-admission-"));
	const base = 49_000 + Math.floor(Math.random() * 500);
	const children: Child[] = [];

	try {
		const a = spawnChild("a", base, base + 10, join(root, "a"));
		const b = spawnChild("b", base + 1, base + 11, join(root, "b"));
		children.push(a, b);

		const [readyA, readyB] = await Promise.all([
			eventually(() => a.command<Ready>({ action: "ready" }), "node A"),
			eventually(() => b.command<Ready>({ action: "ready" }), "node B"),
		]);

		const nearbyA = await eventually(async () => {
			const rows = await a.command<Nearby[]>({ action: "nearby" });
			const found = rows.find((row) => row.id === readyB.identity.id);
			if (!found) throw new Error("node B not discovered");
			return found;
		}, "mDNS discovery A → B");
		await eventually(async () => {
			const rows = await b.command<Nearby[]>({ action: "nearby" });
			if (!rows.some((row) => row.id === readyA.identity.id)) throw new Error("node A not discovered");
			return true;
		}, "mDNS discovery B → A");

		const deniedRequest = await a.command<{ ok: boolean; requestId?: string }>({
			action: "request",
			nodeId: nearbyA.id,
			name: nearbyA.name,
			origin: nearbyA.origin,
		});
		if (!deniedRequest.ok || !deniedRequest.requestId) throw new Error("nearby request was not sent");
		const deniedIncoming = await eventually(async () => {
			const rows = await b.command<Incoming[]>({ action: "incoming" });
			const found = rows.find((row) => row.id === deniedRequest.requestId);
			if (!found) throw new Error("incoming request not visible");
			if (found.node.fingerprint !== readyA.identity.fingerprint) {
				throw new Error("incoming fingerprint does not match requester");
			}
			return found;
		}, "incoming request");
		await b.command({ action: "decide", id: deniedIncoming.id, decision: "deny" });
		await eventually(async () => {
			const rows = await a.command<Outgoing[]>({ action: "outgoing" });
			if (rows.find((row) => row.id === deniedIncoming.id)?.status !== "denied") {
				throw new Error("denial not reported to requester");
			}
			return true;
		}, "denial result");
		if ((await a.command<Peer[]>({ action: "peers" })).length !== 0) {
			throw new Error("denial must not link a peer");
		}

		const acceptedRequest = await a.command<{ ok: boolean; requestId?: string }>({
			action: "request",
			nodeId: nearbyA.id,
			name: nearbyA.name,
			origin: nearbyA.origin,
		});
		if (!acceptedRequest.ok || !acceptedRequest.requestId) throw new Error("second request was not sent");
		const acceptedIncoming = await eventually(async () => {
			const rows = await b.command<Incoming[]>({ action: "incoming" });
			const found = rows.find((row) => row.id === acceptedRequest.requestId);
			if (!found) throw new Error("second incoming request not visible");
			return found;
		}, "accepted request");
		const accepted = await b.command<{ ok: boolean; error?: string }>({
			action: "decide",
			id: acceptedIncoming.id,
			decision: "accept",
		});
		if (!accepted.ok) throw new Error(`accept failed: ${accepted.error}`);

		await assertLinked(a, b, readyA, readyB);
		await eventually(async () => {
			const [callsA, callsB] = await Promise.all([
				a.command<string[]>({ action: "calls" }),
				b.command<string[]>({ action: "calls" }),
			]);
			if (!callsA.includes("listPersonas") || !callsB.includes("listPersonas")) {
				throw new Error("direct peer wires are not both up");
			}
			return true;
		}, "direct node wires");

		await Promise.all([
			a.command({ action: "revoke", id: readyB.identity.id }),
			b.command({ action: "revoke", id: readyA.identity.id }),
		]);
		const invite = await a.command<{ origin?: string; code?: string; error?: string }>({ action: "invite" });
		if (!invite.origin || !invite.code) throw new Error(`advanced invite failed: ${invite.error}`);
		const joined = await b.command<{ ok: boolean; error?: string }>({
			action: "join",
			origin: invite.origin,
			code: invite.code,
		});
		if (!joined.ok) throw new Error(`advanced join failed: ${joined.error}`);
		await assertLinked(a, b, readyA, readyB);

		console.log("node-admission: discovery, deny, accept, direct wire, and advanced token hold");
	} finally {
		await Promise.all(children.map((child) => child.command({ action: "stop" }).catch(() => undefined)));
		await Promise.all(children.map((child) => child.process.exited));
		rmSync(root, { recursive: true, force: true });
	}
}

type Ready = {
	identity: { id: string; name: string; fingerprint: string };
	origin: string;
};
type Nearby = { id: string; name: string; origin: string };
type Incoming = { id: string; node: { fingerprint: string } };
type Outgoing = { id: string; status: string };
type Peer = { id: string };

async function assertLinked(a: Child, b: Child, readyA: Ready, readyB: Ready): Promise<void> {
	await eventually(async () => {
		const [peersA, peersB, admissionsA, admissionsB] = await Promise.all([
			a.command<Peer[]>({ action: "peers" }),
			b.command<Peer[]>({ action: "peers" }),
			a.command<Array<{ node: { id: string } }>>({ action: "admissions" }),
			b.command<Array<{ node: { id: string } }>>({ action: "admissions" }),
		]);
		if (!peersA.some((peer) => peer.id === readyB.identity.id)) throw new Error("A has not linked B");
		if (!peersB.some((peer) => peer.id === readyA.identity.id)) throw new Error("B has not linked A");
		if (!admissionsA.some((row) => row.node.id === readyB.identity.id)) throw new Error("A has no admission");
		if (!admissionsB.some((row) => row.node.id === readyA.identity.id)) throw new Error("B has no admission");
		return true;
	}, "paired membership");
}

function spawnChild(label: string, nodePort: number, controlPort: number, dataDir: string): Child {
	const childProcess = Bun.spawn([process.execPath, fileURLToPath(import.meta.url)], {
		env: {
			...globalThis.process.env,
			TOAD_NODE_CHILD: label,
			TOAD_NODE_PORT: String(nodePort),
			TOAD_NODE_CONTROL_PORT: String(controlPort),
			TOAD_DATA_DIR: dataDir,
		},
		stdout: "inherit",
		stderr: "inherit",
	});
	return {
		label,
		controlPort,
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
	while (Date.now() < deadline) {
		try {
			return await run();
		} catch (error) {
			last = error;
			await Bun.sleep(150);
		}
	}
	throw new Error(`${label}: ${last instanceof Error ? last.message : String(last)}`);
}
