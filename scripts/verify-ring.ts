/**
 * The ring, driven against the real transcript store on a scratch data
 * directory: an agent marking its own message, and the user taking it off.
 *
 * - the tool descriptor and the pi wrappers carry the same closed set, and a
 *   hex or an unknown word is refused before it can reach a record
 * - a ring lands on the agent's own latest message, is durable in the tape,
 *   and survives a reload and a compaction
 * - the rate guard is structural: an agent cannot reach a bubble from an
 *   earlier turn, cannot ring the user's message, and is refused with a
 *   sentence when it has not spoken yet
 * - re-ringing with another intent replaces rather than accumulates, and it
 *   is one record either way
 * - the by-id write behind the RPC method sets and clears any bubble, agent's
 *   or user's — no UI reaches it (a ring is paint, not a control), but it is
 *   the general path the contract and the plane still expose
 *
 * Run: bun scripts/verify-ring.ts
 */
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "toad-ring-"));
process.env.TOAD_DATA_DIR = root;

const transcript = await import("../src/bun/store/transcript");
const { ringAgentMessage, setMessageRing } = await import("../src/bun/agent/ring");
const { RING_INTENTS, isRingIntent, ringLabel, ringToken } = await import("../src/shared/ring");
const { TOAD_TOOLS, validToadToolArgs } = await import("../src/bun/mcp/tools");
const { ARM_TOOL_POLICY } = await import("../src/bun/pi/toad-tools");

import { McpServer, InMemoryTransport, fromJsonSchema } from "@modelcontextprotocol/server";

import type { RingIntent } from "../src/shared/ring";
import type { TranscriptEvent } from "../src/shared/types";

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, detail?: unknown) => {
	console.log(
		ok ? `\x1b[32m  PASS\x1b[0m ${label}` : `\x1b[31m  FAIL\x1b[0m ${label}`,
		detail === undefined || ok ? "" : JSON.stringify(detail),
	);
	ok ? pass++ : fail++;
};

const persona = "ring-teammate";
let clock = 1_700_000_000_000;
const say = (kind: "user" | "agent", text: string): TranscriptEvent => {
	const event = { kind, id: randomUUID(), ts: (clock += 1_000), text } as TranscriptEvent;
	transcript.append(persona, event);
	return event;
};

/** The production write path, minus the window that would receive the push. */
const pushes: TranscriptEvent[] = [];
const write = (event: TranscriptEvent) => {
	transcript.append(persona, event);
	pushes.push(event);
};

const ringOf = (id: string) => {
	const found = transcript.load(persona).find((event) => event.id === id);
	return found && (found.kind === "user" || found.kind === "agent") ? found.ring : undefined;
};

// ---------------------------------------------------------------------------
// The contract the model sees
// ---------------------------------------------------------------------------

console.log("\nWhat an agent is allowed to name");

{
	const tool = TOAD_TOOLS.find((candidate) => candidate.name === "ring_message");
	check("the tool exists in the one list both paths read", Boolean(tool));
	const declared = (tool?.inputSchema as unknown as { properties?: { intent?: { enum?: string[] } } })
		?.properties?.intent?.enum;
	check("its schema offers exactly the closed set", JSON.stringify(declared) === JSON.stringify([...RING_INTENTS]), declared);
	check(
		"a subagent does not inherit it",
		ARM_TOOL_POLICY.ring_message?.arm === false,
		ARM_TOOL_POLICY.ring_message,
	);
}

{
	const good = RING_INTENTS.every((intent) => validToadToolArgs("ring_message", { intent }));
	const bad = ["#ff0000", "red", "done", "question", "", "ATTENTION"].every(
		(intent) => !validToadToolArgs("ring_message", { intent }),
	);
	check("every intent in the set validates", good);
	check("a hex, a colour name, and a word outside the set do not", bad);
	check("neither does an extra key", !validToadToolArgs("ring_message", { intent: "attention", hex: "#f00" }));
	check("nor a missing one", !validToadToolArgs("ring_message", {}));
	check("nothing outside the set is an intent at all", !isRingIntent("chartreuse"));
	check(
		"and each one has a palette family and a legend word",
		RING_INTENTS.every((intent) => ringToken(intent).length > 0 && ringLabel(intent).length > 0),
	);
}

/**
 * What an ACP backend is actually offered.
 *
 * The pi wrappers hand the schema to the model directly, but a sidecar backend
 * only ever sees what `tools/list` says — and a closed set that arrives as a
 * bare string is not a closed set at all. Driven through a real MCP server over
 * an in-memory pair, because the only trustworthy answer is the one on the wire.
 */
{
	const server = new McpServer({ name: "toad", version: "verify" });
	for (const tool of TOAD_TOOLS) {
		server.registerTool(
			tool.name,
			{
				description: tool.description,
				inputSchema: fromJsonSchema(tool.inputSchema as Record<string, unknown>),
			},
			async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
		);
	}
	const [client, wire] = InMemoryTransport.createLinkedPair();
	await server.connect(wire);
	const replies: Array<Record<string, unknown>> = [];
	client.onmessage = (message: unknown) => replies.push(message as Record<string, unknown>);
	await client.start();
	await client.send({
		jsonrpc: "2.0",
		id: 1,
		method: "initialize",
		params: {
			protocolVersion: "2025-06-18",
			capabilities: {},
			clientInfo: { name: "verify-ring", version: "1" },
		},
	});
	await client.send({ jsonrpc: "2.0", method: "notifications/initialized" });
	await client.send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
	await new Promise((resolve) => setTimeout(resolve, 300));

	const listed = replies.find((message) => message.id === 2) as
		| { result?: { tools?: Array<{ name: string; inputSchema?: unknown }> } }
		| undefined;
	const advertised = listed?.result?.tools?.find((tool) => tool.name === "ring_message");
	check("the sidecar advertises the tool to an ACP backend", Boolean(advertised));
	const declared = (advertised?.inputSchema as { properties?: { intent?: { enum?: string[] } } })
		?.properties?.intent?.enum;
	check(
		"and the closed set survives the round trip onto the wire",
		JSON.stringify(declared) === JSON.stringify([...RING_INTENTS]),
		declared,
	);
	await client.close();
	await server.close();
}

// ---------------------------------------------------------------------------
// The agent's own hand
// ---------------------------------------------------------------------------

console.log("\nThe agent rings what it just wrote");

{
	const asked = say("user", "How did the calendar look?");
	const nothing = ringAgentMessage(transcript.load(persona), "attention", write);
	check("with nothing said yet, it is refused", "error" in nothing, nothing);
	check("and the refusal says what to do instead", "error" in nothing && nothing.error.includes("Write the message first"));
	check("nothing was written", pushes.length === 0);

	const review = say("agent", "Three meetings, one clash at 14:00.");
	const done = ringAgentMessage(transcript.load(persona), "attention", write);
	check("after speaking, the ring lands", !("error" in done), done);
	check("on the message it just wrote", ringOf(review.id) === "attention", ringOf(review.id));
	check("and never on the user's", ringOf(asked.id) === undefined);
	check(
		"the result names the message, for the tool's answer",
		"text" in done && done.text.startsWith("Three meetings"),
	);
}

{
	// A second turn: the older ringed bubble is out of reach, which is the
	// whole rate guard — an agent gets one ring per thing it says.
	const before = transcript.load(persona).filter((event) => event.kind === "agent").at(-1)!;
	say("user", "And tomorrow?");
	const early = ringAgentMessage(transcript.load(persona), "warning", write);
	check("it cannot reach back into the previous turn", "error" in early, early);
	check("the earlier ring is untouched", ringOf(before.id) === "attention");

	const next = say("agent", "Tomorrow is clear.");
	ringAgentMessage(transcript.load(persona), "warning", write);
	check("the new message takes the new intent", ringOf(next.id) === "warning", ringOf(next.id));
	check("and yesterday's ring is still there, which is the point of durability", ringOf(before.id) === "attention");
}

{
	const latest = transcript.load(persona).filter((event) => event.kind === "agent").at(-1)!;
	const writes = pushes.length;
	ringAgentMessage(transcript.load(persona), "warning", write);
	check("ringing the same intent twice writes nothing", pushes.length === writes);
	ringAgentMessage(transcript.load(persona), "problem", write);
	check("a different intent replaces rather than accumulates", ringOf(latest.id) === "problem");
	check(
		"and the tape still holds one bubble for it",
		transcript.load(persona).filter((event) => event.id === latest.id).length === 1,
	);
}

// ---------------------------------------------------------------------------
// Durability
// ---------------------------------------------------------------------------

console.log("\nThe ring is a fact in the tape");

{
	const ringed = transcript
		.load(persona)
		.filter((event) => (event.kind === "agent" || event.kind === "user") && event.ring);
	check("two messages are ringed after all of that", ringed.length === 2, ringed.length);

	const lines = transcript
		.segmentFiles(persona)
		.flatMap((segment) => readFileSync(segment.path, "utf8").trim().split("\n"))
		.filter((line) => line.length > 0);
	const written = lines
		.map((line) => JSON.parse(line) as TranscriptEvent)
		.filter((event) => (event.kind === "agent" || event.kind === "user") && event.ring);
	check("and the rings are on disk, not only in memory", written.length >= 2, written.length);

	transcript.compact(persona);
	const survived = transcript
		.load(persona)
		.filter((event) => (event.kind === "agent" || event.kind === "user") && event.ring);
	check("compaction keeps them", survived.length === 2, survived.length);
}

// ---------------------------------------------------------------------------
// The way out
// ---------------------------------------------------------------------------

console.log("\nThe by-id write");

{
	const events = transcript.load(persona);
	const ringed = events.find(
		(event) => (event.kind === "agent" || event.kind === "user") && event.ring === "attention",
	)!;
	check("clearing a ring the agent put on works", setMessageRing(transcript.load(persona), ringed.id, null, write));
	check("and it is gone", ringOf(ringed.id) === undefined, ringOf(ringed.id));
	check("clearing it again changes nothing", !setMessageRing(transcript.load(persona), ringed.id, null, write));

	const theirs = events.find((event) => event.kind === "user")!;
	check(
		"the by-id write reaches any bubble, including the user's own",
		setMessageRing(transcript.load(persona), theirs.id, "attention", write),
	);
	check("and it sticks", ringOf(theirs.id) === "attention");

	check(
		"a ring on machinery is refused",
		!setMessageRing(
			[{ kind: "thought", id: "t1", ts: 1, text: "hm" } as TranscriptEvent],
			"t1",
			"attention" as RingIntent,
			write,
		),
	);
	check(
		"and so is a ring on nothing",
		!setMessageRing(transcript.load(persona), randomUUID(), "attention", write),
	);
}

console.log(`\n${pass} pass, ${fail} fail`);
rmSync(root, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
