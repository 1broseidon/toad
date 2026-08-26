import { beforeAll, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { answerHuman, configureHandoff } from "../computer/handoff";
import type { TranscriptEvent } from "../../shared/types";

const { Bridge } = await import("./bridge");
const paths = await import("../paths");

// The throwaway root comes from test/preload.ts. Setting it here instead would
// be too late: the static imports above already resolved it.
const dataDir = paths.ROOT;
type BridgeResponse = import("./protocol").BridgeResponse;
type BridgeScope = import("./protocol").BridgeScope;
type DeliverResult = import("../acp/peers").DeliverResult;

const personas = [
	{ id: "alice", name: "Alice" },
	{ id: "bob", name: "Bob" },
].map((persona, index) => ({
	...persona,
	goal: "",
	backendId: "test",
	cwd: join(dataDir, persona.id),
	mcpPolicy: { mode: "none" as const, serverIds: [] },
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

const unusedScheduler = {
	list: () => [],
	schedule: () => {
		throw new Error("unused");
	},
	loop: () => {
		throw new Error("unused");
	},
	cancel: () => false,
};
const unusedChapters = {
	search: () => ({ hits: [], truncated: false }),
	list: () => [],
	resume: () => ({ ok: false as const, reason: "unused", detail: "unused" }),
	startFresh: async () => ({}),
};

async function once(predicate: () => boolean, ms = 1_000): Promise<void> {
	const deadline = Date.now() + ms;
	while (!predicate() && Date.now() < deadline) await Bun.sleep(5);
	expect(predicate()).toBe(true);
}

beforeAll(() => {
	paths.ensureLayout();
	writeFileSync(paths.CONFIG_FILE, `${JSON.stringify({ version: 1, personas })}\n`);
});

describe("message_teammate", () => {
	test("returns as soon as the message is sent and notifies when they reply", async () => {
		const deferred = Promise.withResolvers<DeliverResult>();
		const notices: string[] = [];
		const bridge = new Bridge({
			supervisor: { info: idleInfo },
			peers: {
				deliver: () => deferred.promise,
				activeDelivery: () => undefined,
			},
			scheduler: unusedScheduler,
			chapters: unusedChapters,
			react: () => ({ error: "unused" }),
			notify: (_id, text) => {
				notices.push(text);
			},
		});
		const dispatch = (
			bridge as unknown as {
				dispatch(
					id: number,
					method: string,
					params: Record<string, unknown>,
					scope: BridgeScope,
				): Promise<BridgeResponse>;
			}
		).dispatch.bind(bridge);

		const started = Date.now();
		const response = await dispatch(
			1,
			"message_teammate",
			{ target: "bob", message: "hello" },
			{ kind: "human", personaId: "alice" },
		);
		expect(Date.now() - started).toBeLessThan(200);
		expect(response.ok).toBe(true);
		if (!response.ok) return;
		expect(response.result).toMatchObject({ sent: true, to: "Bob", target: "bob" });
		expect(notices).toEqual([]);

		deferred.resolve({ ok: true, from: "Bob", reply: "ship it" });
		await once(() => notices.length === 1);
		expect(notices[0]).toContain("ship it");
		expect(notices[0]).toContain("read_agent_thread");
	});

	test("unknown targets still fail the tool immediately", async () => {
		let delivered = false;
		const bridge = new Bridge({
			supervisor: { info: idleInfo },
			peers: {
				deliver: async () => {
					delivered = true;
					return { ok: false as const, reason: "internal" as const, detail: "no" };
				},
				activeDelivery: () => undefined,
			},
			scheduler: unusedScheduler,
			chapters: unusedChapters,
			react: () => ({ error: "unused" }),
		});
		const dispatch = (
			bridge as unknown as {
				dispatch(
					id: number,
					method: string,
					params: Record<string, unknown>,
					scope: BridgeScope,
				): Promise<BridgeResponse>;
			}
		).dispatch.bind(bridge);
		const response = await dispatch(
			1,
			"message_teammate",
			{ target: "nobody", message: "hello" },
			{ kind: "human", personaId: "alice" },
		);
		expect(response.ok).toBe(false);
		if (!response.ok) expect(response.error.code).toBe("not_found");
		expect(delivered).toBe(false);
	});
});

describe("request_human", () => {
	test("posts the card and notifies when they answer", async () => {
		const notices: string[] = [];
		let actionId = "";
		configureHandoff({
			append: (_personaId, event: TranscriptEvent) => {
				if (event.kind === "human_action") actionId = event.actionId;
			},
			update: () => {},
		});
		const bridge = new Bridge({
			supervisor: { info: idleInfo },
			peers: {
				deliver: async () => ({ ok: false as const, reason: "internal" as const, detail: "unused" }),
				activeDelivery: () => undefined,
			},
			scheduler: unusedScheduler,
			chapters: unusedChapters,
			react: () => ({ error: "unused" }),
			notify: (_id, text) => {
				notices.push(text);
			},
		});
		const dispatch = (
			bridge as unknown as {
				dispatch(
					id: number,
					method: string,
					params: Record<string, unknown>,
					scope: BridgeScope,
				): Promise<BridgeResponse>;
			}
		).dispatch.bind(bridge);

		const started = Date.now();
		const response = await dispatch(
			1,
			"request_human",
			{ reason: "Tap the 2FA prompt", timeout: 60 },
			{ kind: "human", personaId: "alice" },
		);
		expect(Date.now() - started).toBeLessThan(200);
		expect(response.ok).toBe(true);
		if (!response.ok) return;
		expect(response.result).toMatchObject({ posted: true, status: "pending" });
		expect(actionId.length).toBeGreaterThan(0);
		expect(notices).toEqual([]);

		expect(answerHuman(actionId, "done")).toBe(true);
		await once(() => notices.length === 1);
		expect(notices[0]).toContain("done");
		expect(notices[0]).toContain("Tap the 2FA prompt");
	});

	test("wait still blocks for a subagent", async () => {
		let actionId = "";
		configureHandoff({
			append: (_personaId, event: TranscriptEvent) => {
				if (event.kind === "human_action") actionId = event.actionId;
			},
			update: () => {},
		});
		const bridge = new Bridge({
			supervisor: { info: idleInfo },
			peers: {
				deliver: async () => ({ ok: false as const, reason: "internal" as const, detail: "unused" }),
				activeDelivery: () => undefined,
			},
			scheduler: unusedScheduler,
			chapters: unusedChapters,
			react: () => ({ error: "unused" }),
		});
		const dispatch = (
			bridge as unknown as {
				dispatch(
					id: number,
					method: string,
					params: Record<string, unknown>,
					scope: BridgeScope,
				): Promise<BridgeResponse>;
			}
		).dispatch.bind(bridge);

		const pending = dispatch(
			1,
			"request_human",
			{ reason: "Enter the vault password", timeout: 60, wait: true },
			{ kind: "human", personaId: "alice" },
		);
		await once(() => actionId.length > 0);
		let settled = false;
		void pending.then(() => {
			settled = true;
		});
		await Bun.sleep(20);
		expect(settled).toBe(false);
		answerHuman(actionId, "dismissed");
		const response = await pending;
		expect(response.ok).toBe(true);
		if (!response.ok) return;
		expect(response.result).toEqual({ status: "dismissed" });
	});
});
