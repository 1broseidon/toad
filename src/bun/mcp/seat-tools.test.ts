import { afterEach, expect, mock, test } from "bun:test";

/**
 * What a seat can reach, and what it is refused.
 *
 * The grant is the whole of the seat-level permission model, so these are the
 * assertions that matter here: a desk the grant does not name is not "offline"
 * to a client, it does not exist, and a target on one is refused by name
 * rather than attempted. Delivery itself needs a live agent and is proven in
 * `verify:mcp-seat` (who the room thinks is speaking) and `verify:mcp` (what
 * the teammate's tape ends up saying).
 *
 * `web/server.ts` is mocked to its origin alone for the same reason `seat.test`
 * does it: importing it for real starts a listener.
 */

mock.module("../web/server", () => ({
	secureOrigin: () => "https://192.0.2.10:4443",
	lanAddress: () => "192.0.2.10",
}));

const { SEAT_TOOLS, callSeatTool, clientMayReach, initSeatTools, validSeatToolArgs } =
	await import("./seat-tools");
const { createPersona, deletePersona } = await import("../store/personas");
const { localNodeId } = await import("../store/records");
const { nodeIdentity } = await import("../node/identity");
const transcript = await import("../store/transcript");

type ClientMember = import("../node/members").ClientMember;

const created: string[] = [];

afterEach(() => {
	while (created.length > 0) deletePersona(created.pop() as string);
});

function teammate(name: string): { id: string; name: string } {
	const persona = createPersona({ name, backendId: "cursor", goal: `${name}'s errand` });
	created.push(persona.id);
	return { id: persona.id, name: persona.name };
}

function seat(grant: string[]): ClientMember {
	return {
		clientId: "mcp_0123456789abcdef",
		name: "Claude Code",
		seat: "client",
		secretHash: "",
		scope: "toad.room",
		grant,
		admittedAt: Date.now(),
		ownerNode: localNodeId(),
		updatedAt: Date.now(),
		software: null,
	};
}

const delivered: Array<Record<string, unknown>> = [];
initSeatTools({
	supervisor: { info: () => ({ state: "idle" }) as never },
	peers: {
		deliver: async (input) => {
			delivered.push(input as unknown as Record<string, unknown>);
			return { ok: true, from: "Boris", reply: "heard" };
		},
	},
});

async function refusal(member: ClientMember, name: string, args: unknown): Promise<string> {
	try {
		await callSeatTool(member, name, args);
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
	throw new Error(`${name} was not refused`);
}

test("a seat is offered the social subset and nothing else", () => {
	expect(SEAT_TOOLS.map((tool) => tool.name).sort()).toEqual([
		"list_desks",
		"list_teammates",
		"message_teammate",
		"read_transcript",
	]);
});

test("arguments are checked against the schema a client was shown", () => {
	expect(validSeatToolArgs("list_desks", {})).toBe(true);
	expect(validSeatToolArgs("list_desks", { desk: "beastie" })).toBe(false);
	expect(validSeatToolArgs("message_teammate", { target: "x", message: "hi" })).toBe(true);
	expect(validSeatToolArgs("message_teammate", { target: "x" })).toBe(false);
	expect(validSeatToolArgs("message_teammate", { target: "x", message: "" })).toBe(false);
	expect(validSeatToolArgs("read_transcript", { target: "x", limit: 200 })).toBe(false);
	// Nothing outside the four is callable, whatever it is named.
	expect(validSeatToolArgs("hop_desk", { desk: "beastie" })).toBe(false);
});

test("everyone in the grant may reach every teammate, until task-31 says otherwise", () => {
	expect(clientMayReach(seat([localNodeId()]), { personaId: "any", nodeId: localNodeId() })).toBe(
		true,
	);
});

test("the desks a seat sees are the ones its grant names", async () => {
	const mine = await callSeatTool(seat([localNodeId()]), "list_desks", {});
	const desks = mine.desks as Array<{ nodeId: string; current?: boolean }>;
	expect(desks).toHaveLength(1);
	expect(desks[0]!.nodeId).toBe(localNodeId());
	expect(desks[0]!.current).toBe(true);
	expect(desks[0]!.name).toBe(nodeIdentity().name);

	/* A grant naming no desk at all is a seat with nothing to see — not an
	 * error, and not a view of the room it was never given. */
	const none = await callSeatTool(seat([]), "list_desks", {});
	expect(none.desks).toEqual([]);
});

test("a target on a desk outside the grant is refused by name, not attempted", async () => {
	const boris = teammate("Boris");
	const shut = seat([]);
	expect(await refusal(shut, "message_teammate", { target: boris.id, message: "hi" })).toContain(
		"not a teammate on any desk in your grant",
	);
	expect(await refusal(shut, "read_transcript", { target: boris.id })).toContain("your grant");
	expect(delivered).toHaveLength(0);

	const elsewhere = `deadbeefdeadbeef/${boris.id}`;
	expect(
		await refusal(seat([localNodeId()]), "message_teammate", {
			target: elsewhere,
			message: "hi",
		}),
	).toContain("No desk in your grant owns");
});

test("a message carries the seat, its name, and the desk it came in through", async () => {
	const boris = teammate("Boris");
	const answer = await callSeatTool(seat([localNodeId()]), "message_teammate", {
		target: boris.id,
		message: "how is the iOS build?",
	});
	expect(answer.reply).toBe("heard");
	const sent = delivered.at(-1)!;
	expect(sent.callerId).toBe("client:mcp_0123456789abcdef");
	expect(sent.targetId).toBe(boris.id);
	expect(sent.outside).toEqual({
		name: "Claude Code",
		node: nodeIdentity().name,
		seat: "client",
	});
});

test("a transcript read answers for a teammate on this desk", async () => {
	const boris = teammate("Boris");
	transcript.append(boris.id, {
		kind: "user",
		id: `seed:${boris.id}`,
		ts: Date.now(),
		text: "what is left on the iOS build?",
	});
	const read = await callSeatTool(seat([localNodeId()]), "read_transcript", { target: boris.id });
	expect(read.name).toBe("Boris");
	expect(read.messages).toEqual([
		expect.objectContaining({ from: "user", text: "what is left on the iOS build?" }),
	]);
});

test("a teammate this desk does not have is not found", async () => {
	expect(
		await refusal(seat([localNodeId()]), "read_transcript", { target: "no-such-teammate" }),
	).toContain("No teammate here");
});
