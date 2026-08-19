/**
 * Read-only: prints every stored peer thread the way the UI will now read it,
 * so envelope leakage and speaker attribution can be checked against real data
 * without launching the app.
 *
 * Run: bun hack/probe-peer-threads.ts
 */
import { PeerSessions } from "../src/bun/acp/peers";
import { listPersonas } from "../src/bun/store/personas";
import * as threads from "../src/bun/store/threads";

const silent = {
	peerThreadAppended: () => {},
	peerThreadUpdated: () => {},
	peerActivityChanged: () => {},
	transcriptAppended: () => {},
	transcriptUpdated: () => {},
};

const peers = new PeerSessions(silent);
const keys = threads.listAllKeys();
console.log(`${keys.length} peer thread(s)\n`);

for (const key of keys) {
	const thread = peers.loadThread(key);
	if (!thread) {
		console.log(`${key}: no metadata`);
		continue;
	}
	console.log(`${thread.sides.user.name}  ↔  ${thread.sides.agent.name}`);
	console.log(`  right side (user): ${thread.sides.user.name}`);
	console.log(`  left side (agent): ${thread.sides.agent.name}\n`);

	for (const event of thread.events) {
		if (event.kind !== "user" && event.kind !== "agent") continue;
		const who = event.kind === "user" ? thread.sides.user.name : thread.sides.agent.name;
		const leaked = /toad_teammate_message|another Toad teammate/.test(event.text);
		const line = event.text.replace(/\s+/g, " ").slice(0, 110);
		console.log(`  ${leaked ? "LEAKED ENVELOPE " : ""}${who}: ${line}${event.text.length > 110 ? "…" : ""}`);
	}
	console.log();
}

for (const persona of listPersonas()) {
	for (const summary of peers.summariesFor(persona.id)) {
		console.log(
			`pill in ${persona.name} → "${summary.withName}" · preview: ` +
				`${summary.preview ? `${summary.preview.fromName}: ${summary.preview.text.replace(/\s+/g, " ").slice(0, 70)}` : "none"}`,
		);
	}
}
