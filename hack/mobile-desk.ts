/**
 * A headless desk for phone-join QA: the real record store, membership,
 * node and web servers from source, with just enough of the RPC surface for
 * the phone app to mount its roster and open a transcript.
 *
 *   bun hack/mobile-desk.ts [webPort] [nodePort]
 *
 * Prints the address to type on the phone. Mint a fresh pairing code any
 * time with:  curl -s http://127.0.0.1:<webPort+2>/code
 *
 * Isolated by default: data lives in /tmp/toad-mobile-desk unless
 * TOAD_DATA_DIR says otherwise. Never point this at a live data directory.
 */
process.env.TOAD_DATA_DIR ??= "/tmp/toad-mobile-desk";
const webPort = Number(process.argv[2] ?? 4699);
const nodePort = Number(process.argv[3] ?? 4698);
process.env.TOAD_NODE_PORT = String(nodePort);
process.env.TOAD_WEB_HTTPS_PORT ??= String(webPort - 2);

import type { SessionInfo } from "../src/shared/types";

const fleet = await import("../src/bun/fleet/fleet");
const wire = await import("../src/bun/fleet/wire");
const nodeServer = await import("../src/bun/node/server");
const identity = await import("../src/bun/node/identity");
const personas = await import("../src/bun/store/personas");
const devices = await import("../src/bun/web/devices");
const web = await import("../src/bun/web/server");

if (personas.listPersonas().length === 0) {
	personas.createPersona({ name: "Patch", goal: "QA on the headless desk", team: "QA" });
	personas.createPersona({ name: "Nimbus", goal: "Second seat for the roster", team: "QA" });
}

function sessionInfo(personaId: string): SessionInfo {
	return {
		personaId,
		state: "stopped",
		contextRestored: false,
		models: [],
		modes: [],
		configs: [],
		slashCommands: [],
		capabilities: { loadSession: false, resume: false, fork: false, mcpHttp: false, image: false },
	};
}

const empty = async () => ({});
const handlers: Record<string, (params: unknown) => Promise<unknown>> = {
	ping: async () => true,
	listPersonas: async () => [...personas.listPersonas(), ...wire.remotePersonas()],
	listPreviews: empty,
	listPeerActivity: empty,
	listSchedules: async () => [],
	listBackends: async () => [],
	listChapters: async () => [],
	listPeerThreads: async () => [],
	getLastPersonaId: async () => null,
	getSessionInfo: async (params) =>
		sessionInfo((params as { personaId?: string })?.personaId ?? ""),
	loadTranscript: async () => [],
	getAppInfo: async () => ({ version: "mobile-desk", dataDir: process.env.TOAD_DATA_DIR }),
	getAppSettings: empty,
	searchAllThreads: async () => ({ hits: [], truncated: false }),
	fleetRoster: async () => ({ node: fleet.fleetNode(), rosters: await fleet.fleetRosters() }),
};
const resolve = (method: string) => handlers[method];

fleet.initFleet({
	createTeammate: (draft) => ({ personaId: "desk-created", name: draft.name }),
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

Bun.serve({
	hostname: "127.0.0.1",
	port: webPort + 2,
	fetch(request) {
		const url = new URL(request.url);
		if (url.pathname === "/code") {
			return Response.json({ code: devices.createPairing() });
		}
		const members = require("../src/bun/node/members") as typeof import("../src/bun/node/members");
		if (url.pathname === "/members") {
			return Response.json(members.listMobileMembers());
		}
		return new Response("mobile-desk control: /code /members", { status: 200 });
	},
});

console.log(`mobile-desk ${identity.nodeIdentity().id} — web ${web.httpOrigin()}, node ${nodeServer.nodeOrigin()}`);
console.log(`personas: ${personas.listPersonas().map((p) => p.name).join(", ")}`);
console.log(`mint a code:  curl -s http://127.0.0.1:${webPort + 2}/code`);
