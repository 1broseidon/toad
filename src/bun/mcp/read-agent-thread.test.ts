import type { Persona } from "../../shared/types";
import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const { Bridge } = await import("./bridge");
const { putLocal } = await import("../store/records");
const { personaClasses } = await import("../store/personas");
const { TOAD_TOOLS, validToadToolArgs } = await import("./tools");
const paths = await import("../paths");
const threads = await import("../store/threads");

// The throwaway root comes from test/preload.ts, which is the only place early
// enough to be sure of it — see the comment there.
const dataDir = paths.ROOT;
type BridgeResponse = import("./protocol").BridgeResponse;
type BridgeScope = import("./protocol").BridgeScope;

const personas = [
	{ id: "alice", name: "Alice" },
	{ id: "bob", name: "Bob", team: "Build" },
	{ id: "carol", name: "Carol", team: "Build" },
	{ id: "dave", name: "Dave" },
].map((persona, index) => ({
	...persona,
	goal: "",
	backendId: "test",
	cwd: join(dataDir, persona.id),
	mcpPolicy: { mode: "none", serverIds: [] },
	sessionCheckpoints: [],
	createdAt: index + 1,
	updatedAt: index + 1,
}));

const idleInfo = (personaId: string) => ({
	personaId,
	state: "idle" as const,
	contextRestored: false,
	models: [],
	modes: [],
	configs: [],
	slashCommands: [],
	capabilities: { loadSession: false, resume: false, fork: false, mcpHttp: false, image: false },
});

const bridge = new Bridge({
	supervisor: { info: idleInfo },
	peers: {
		deliver: async () => ({ ok: false as const, reason: "internal" as const, detail: "unused" }),
		activeDelivery: () => undefined,
	},
	scheduler: { list: () => [], schedule: () => { throw new Error("unused"); }, loop: () => { throw new Error("unused"); }, cancel: () => false },
	chapters: { search: () => ({ hits: [], truncated: false }), list: () => [], resume: () => ({ ok: false as const, reason: "unused", detail: "unused" }), startFresh: async () => ({}) },
	react: () => ({ error: "unused" }),
});

const dispatch = (scope: BridgeScope, target: string, limit?: number) =>
	(bridge as unknown as {
		dispatch(id: number, method: string, params: Record<string, unknown>, scope: BridgeScope): Promise<BridgeResponse>;
	}).dispatch(1, "read_agent_thread", { target, ...(limit === undefined ? {} : { limit }) }, scope);

const humanScope = (personaId: string): BridgeScope => ({ kind: "human", personaId });

beforeAll(() => {
	paths.ensureLayout();
	/* Through the records store, not config.json: the legacy file migrates
	 * exactly once per process, and in a shared-process test run another
	 * file's fixtures win that race. putLocal is the same door the
	 * migration itself uses. */
	for (const persona of personas) {
		putLocal("persona", persona.id, personaClasses(persona as Persona));
	}
	const key = paths.threadKey("alice", "bob");
	threads.ensure(key, "alice", "bob");
	threads.append(key, { kind: "user", id: "u1", ts: 1, text: "first" });
	threads.append(key, { kind: "thought", id: "x1", ts: 2, text: "private thought" });
	threads.append(key, { kind: "turn", id: "t1", ts: 3, stopReason: "end_turn" });
	threads.append(key, { kind: "agent", id: "a1", ts: 4, text: "second" });
	threads.append(key, { kind: "user", id: "u2", ts: 5, text: "third" });
});

describe("read_agent_thread", () => {
	test("is registered with the constrained target/limit schema", () => {
		const tool = TOAD_TOOLS.find((candidate) => candidate.name === "read_agent_thread");
		expect(tool?.inputSchema).toMatchObject({
			required: ["target"],
			additionalProperties: false,
			properties: { limit: { minimum: 1, maximum: 100, default: 30 } },
		});
		expect(validToadToolArgs("read_agent_thread", { target: "bob", limit: 100 })).toBe(true);
		expect(validToadToolArgs("read_agent_thread", { target: "bob", threadKey: "alice~bob" })).toBe(false);
	});

	test("reads only recent messages and orients each side to the caller", async () => {
		const response = await dispatch(humanScope("alice"), "bob", 2);
		expect(response.ok).toBe(true);
		if (!response.ok) return;
		expect(response.result).toMatchObject({
			threadKey: "alice~bob",
			personaId: "bob",
			name: "Bob",
			messages: [
				{ from: "them", text: "second", at: 4 },
				{ from: "me", text: "third", at: 5 },
			],
			truncated: true,
		});
		expect(JSON.stringify(response)).not.toContain("private thought");
	});

	test("the opposite participant sees the same persisted pair with reversed roles", async () => {
		const response = await dispatch(humanScope("bob"), "alice");
		expect(response.ok).toBe(true);
		if (!response.ok) return;
		expect(response.result.messages).toEqual([
			{ from: "them", text: "first", at: 1 },
			{ from: "me", text: "second", at: 4 },
			{ from: "them", text: "third", at: 5 },
		]);
	});

	test("cannot select or infer a thread between two other teammates", async () => {
		const arbitrary = await dispatch(humanScope("carol"), "bob");
		expect(arbitrary.ok).toBe(false);
		if (!arbitrary.ok) expect(arbitrary.error.code).toBe("not_found");

		const keyAsTarget = await dispatch(humanScope("carol"), "alice~bob");
		expect(keyAsTarget.ok).toBe(false);
		if (!keyAsTarget.ok) expect(keyAsTarget.error.code).toBe("not_found");

		// Peer scope carries routing details, but personaId remains the caller's
		// identity. Those details must not become authority to read their pair.
		const spoofed = await dispatch(
			{
				kind: "peer",
				personaId: "carol",
				threadKey: "alice~bob",
				callerId: "alice",
				targetId: "bob",
			},
			"bob",
		);
		expect(spoofed.ok).toBe(false);
		if (!spoofed.ok) expect(spoofed.error.code).toBe("not_found");
	});

	test("rejects malformed metadata or participants that do not match the derived pair", async () => {
		const key = paths.threadKey("alice", "dave");
		threads.ensure(key, "alice", "dave");
		threads.append(key, { kind: "agent", id: "secret", ts: 9, text: "do not leak" });
		const meta = JSON.parse(readFileSync(paths.threadMetaPath(key), "utf8"));
		meta.a = "bob";
		writeFileSync(paths.threadMetaPath(key), JSON.stringify(meta));

		const mismatched = await dispatch(humanScope("alice"), "dave");
		expect(mismatched.ok).toBe(false);
		if (!mismatched.ok) expect(mismatched.error.code).toBe("not_found");

		meta.a = "alice";
		delete meta.sides;
		writeFileSync(paths.threadMetaPath(key), JSON.stringify(meta));
		const malformed = await dispatch(humanScope("alice"), "dave");
		expect(malformed.ok).toBe(false);
		if (!malformed.ok) expect(malformed.error.code).toBe("not_found");
	});

	test("a team target resolves to the member owning its standing thread", async () => {
		writeFileSync(
			join(dataDir, "teams.json"),
			JSON.stringify({ build: { bob: 50, carol: 100 } }),
		);
		const key = paths.threadKey("alice", "carol");
		threads.ensure(key, "alice", "carol");
		threads.append(key, { kind: "agent", id: "team-reply", ts: 10, text: "team reply" });

		const response = await dispatch(humanScope("alice"), "BUILD");
		expect(response.ok).toBe(true);
		if (!response.ok) return;
		expect(response.result).toMatchObject({ threadKey: "alice~carol", personaId: "carol" });
	});
});
