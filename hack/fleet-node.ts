/**
 * A second Toad desktop, minus the desktop: enough of a node to test the
 * fleet end to end on one machine. It has an identity, a persona, the real
 * pairing and RPC handlers served over HTTP, and a stub deliver that echoes.
 *
 *   TOAD_DATA_DIR=/tmp/toad-fleet-b bun hack/fleet-node.ts [port]
 *
 * Then, from the real desktop: mint an invite, and have this node claim it:
 * the two exchange tokens exactly as two full desktops would.
 */
process.env.TOAD_DATA_DIR ??= "/tmp/toad-fleet-b";
const port = Number(process.argv[2] ?? 4690);

const { createPersona, listPersonas } = await import("../src/bun/store/personas");
const fleet = await import("../src/bun/fleet/fleet");

if (listPersonas().length === 0) {
	createPersona({ name: "Patch", backendId: "pi", goal: "QA on the second box" });
	const persona = listPersonas()[0]!;
	const { updatePersona } = await import("../src/bun/store/personas");
	updatePersona(persona.id, { team: "QA" });
}

fleet.initFleet({
	stateOf: () => "ready",
	deliver: async ({ fromPersona, message }) => ({
		ok: true,
		from: "Patch",
		reply: `Patch here on node B — got your message (${message.length} chars) from ${fromPersona.name}. All quiet.`,
	}),
	httpOrigin: () => `http://127.0.0.1:${port}`,
});

Bun.serve({
	port,
	async fetch(request) {
		const url = new URL(request.url);
		if (url.pathname === "/fleet/pair" && request.method === "POST") {
			const result = fleet.handleFleetPair(await request.json());
			return Response.json(result.body, { status: result.status });
		}
		if (url.pathname === "/fleet/rpc" && request.method === "POST") {
			const bearer = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? null;
			const result = await fleet.handleFleetRpc(bearer, await request.json());
			return Response.json(result.body, { status: result.status });
		}
		return new Response("fleet node", { status: 200 });
	},
});

console.log(`fleet node ${JSON.stringify(fleet.fleetNode())} on :${port}`);
console.log("personas:", listPersonas().map((p) => `${p.name} [${p.team ?? "-"}] ${p.id}`).join(", "));
