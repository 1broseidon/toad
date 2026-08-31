/**
 * The cross-plane task board: the plugin API's first proof case.
 *
 * Five tools and one log. It grants `fleet.log` and `fleet.events` and nothing
 * else — no RPC, no blobs — which the plugin page shows, and which is the point:
 * the board is the example that says a plugin should hold the narrowest set of
 * grants that does its job.
 *
 * Every desk that installs this owns exactly one log, `ops`, and mirrors every
 * other desk's. `board_claim` is the contentious operation and the reason the
 * log pattern earns its place: two desks claim concurrently, both lines exist
 * in different logs, every desk folds both and the lowest `(lamport, desk)`
 * wins. The loser learns it lost when its mirror catches up. No coordinator, no
 * lock, no leader election — and it resolves correctly while a desk is dark.
 *
 * `board_list` reports its own completeness, which is better than Toad's own
 * record plane manages: `plugin.log.cursors` says which owners this desk holds
 * and which it does not, so the answer is "showing 3 of 4 writers; Mac mini's
 * board is not reachable from here" rather than three tasks and a silence.
 *
 * The brainfile markdown is written locally from this desk's own fold, with
 * this process's own filesystem, and Toad is not involved — so the projection
 * cannot become a coordination path.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { McpServer, fromJsonSchema } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { ToadBridge } from "../toad-plugin-sdk/bridge";
import { fold, renderMarkdown, type BoardOp, type Fold } from "./fold";

const LOG_ID = "ops";
const DEFAULT_TTL_MINUTES = 30;

/** What the desk holds of each writer's log, so a fold re-reads only new bytes. */
const cache = new Map<string, { gen: number; text: string }>();

let bridge: ToadBridge | null = null;
let lastDigest = "";

function storagePath(...parts: string[]): string {
	return join(process.env.TOAD_PLUGIN_STORAGE ?? ".", ...parts);
}

/**
 * Reads every writer's log and folds them.
 *
 * The cursor exchange is the plugin's, not Toad's: `plugin.log.cursors` says
 * how many bytes of each generation are held, and this reads forward from what
 * it already has. A generation whose held byte count went *down* is a mirror
 * that was reset behind an owner's rewrite, so its cache entry is dropped and
 * it is read from zero — the same recovery the mirror store performs one layer
 * below, for the same reason.
 */
async function readAll(): Promise<{ logs: Array<{ owner: string; text: string }>; completeness: string }> {
	if (!bridge) return { logs: [], completeness: "not connected to this desk's room" };
	const cursors = await bridge.cursors(LOG_ID);
	const writers: Array<{ owner: string; gen: number; bytes: number }> = [];
	if (cursors.self) {
		writers.push({ owner: cursors.self.nodeId, gen: cursors.self.gen, bytes: cursors.self.bytes });
	}
	for (const mirror of cursors.mirrors) {
		for (const [gen, entry] of Object.entries(mirror.gens)) {
			writers.push({ owner: mirror.nodeId, gen: Number(gen), bytes: entry.held });
		}
	}

	const logs: Array<{ owner: string; text: string }> = [];
	for (const writer of writers) {
		const key = `${writer.owner}/${writer.gen}`;
		const held = cache.get(key);
		let text = held && held.gen === writer.gen ? held.text : "";
		if (Buffer.byteLength(text, "utf8") > writer.bytes) text = "";
		for (;;) {
			const from = Buffer.byteLength(text, "utf8");
			if (from >= writer.bytes) break;
			const chunk = await bridge.read({
				logId: LOG_ID,
				ownerNode: writer.owner,
				gen: writer.gen,
				from,
				len: Math.min(64 * 1024, writer.bytes - from),
			});
			if (!chunk.text) break;
			text += chunk.text;
		}
		cache.set(key, { gen: writer.gen, text });
		logs.push({ owner: writer.owner, text });
	}

	const seen = new Set(writers.map((writer) => writer.owner));
	const completeness =
		cursors.absent.length === 0
			? `showing all ${seen.size} writer${seen.size === 1 ? "" : "s"}`
			: `showing ${seen.size} of ${seen.size + cursors.absent.length} writers — ${cursors.absent
					.map((entry) => entry.reason)
					.join("; ")}`;
	return { logs, completeness };
}

async function current(): Promise<{ state: Fold; completeness: string }> {
	const { logs, completeness } = await readAll();
	const state = fold(logs);
	project(state, completeness);
	await announceDigest(state);
	return { state, completeness };
}

/** The one-way projection. Local file, local fold, nobody else's business. */
function project(state: Fold, completeness: string): void {
	try {
		const path = storagePath("board.md");
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, renderMarkdown(state, completeness));
	} catch {
		/* A projection that cannot be written is not a reason to refuse a claim. */
	}
}

/**
 * Two desks at the same cursor set reporting different digests have folded the
 * same bytes differently, which is the one failure that would otherwise rot
 * invisibly. Emitted only when it changed, because an event nobody may rely on
 * is still an event somebody has to carry.
 */
async function announceDigest(state: Fold): Promise<void> {
	if (!bridge || state.digest === lastDigest) return;
	lastDigest = state.digest;
	await bridge
		.emit("foldDigest", { digest: state.digest, tasks: state.tasks.length })
		.catch(() => undefined);
}

/** Every write stamps `1 + the highest lamport anywhere it has folded`. */
async function write(op: BoardOp): Promise<{ state: Fold; completeness: string }> {
	if (!bridge) throw new Error("this desk's room is not reachable from the board plugin");
	const before = await current();
	await bridge.append(LOG_ID, {
		...op,
		opId: randomUUID(),
		lamport: before.state.maxLamport + 1,
		at: Date.now(),
	});
	cache.clear();
	return current();
}

function summarize(state: Fold, completeness: string): string {
	if (state.tasks.length === 0) return `No tasks. ${completeness}.`;
	const rows = state.tasks.map((task) => {
		const status = task.done
			? `done by ${task.doneBy}`
			: task.claim
				? `claimed by ${task.claim.by} (${task.claim.desk})`
				: "open";
		return `${task.taskId}  ${task.title} — ${status}`;
	});
	return [...rows, "", completeness, `fold digest ${state.digest.slice(0, 12)}`].join("\n");
}

serveStdio(() => {
	const server = new McpServer({
		name: process.env.TOAD_PLUGIN_ID ?? "board",
		version: "0.1.0",
	});

	const text = (value: string) => ({ content: [{ type: "text" as const, text: value }] });
	/* `fromJsonSchema` hands the handler `unknown`, which is honest: the schema
	 * is JSON the server validated, not a TypeScript type. One cast at the top
	 * of each handler, named, beats sprinkling `any` through the bodies. */
	const args = <T>(value: unknown) => (value ?? {}) as T;

	server.registerTool(
		"board_create",
		{
			description: "Add a task to the fleet board, visible on every desk in the room.",
			inputSchema: fromJsonSchema({
				type: "object",
				properties: { title: { type: "string" }, note: { type: "string" } },
				required: ["title"],
				additionalProperties: false,
			}),
		},
		async (raw) => {
			const { title, note } = args<{ title: string; note?: string }>(raw);
			const taskId = randomUUID().slice(0, 8);
			const { state, completeness } = await write({
				op: "create",
				taskId,
				title: String(title),
				...(note ? { note: String(note) } : {}),
			});
			return text(`Created ${taskId}.\n\n${summarize(state, completeness)}`);
		},
	);

	server.registerTool(
		"board_claim",
		{
			description:
				"Claim a task so no other desk works it. Two desks claiming at once both write; the whole room agrees on the same winner and the loser is told.",
			inputSchema: fromJsonSchema({
				type: "object",
				properties: {
					taskId: { type: "string" },
					by: { type: "string", description: "Who is claiming — a teammate's name" },
					ttlMinutes: { type: "number" },
				},
				required: ["taskId", "by"],
				additionalProperties: false,
			}),
		},
		async (raw) => {
			const { taskId, by, ttlMinutes } = args<{
				taskId: string;
				by: string;
				ttlMinutes?: number;
			}>(raw);
			const ttl = Number(ttlMinutes ?? DEFAULT_TTL_MINUTES);
			const { state, completeness } = await write({
				op: "claim",
				taskId: String(taskId),
				by: String(by),
				expiresAt: Date.now() + ttl * 60_000,
			});
			const task = state.tasks.find((entry) => entry.taskId === taskId);
			if (!task) return text(`No task ${taskId}. ${completeness}.`);
			if (task.claim?.by !== by) {
				return text(
					`${taskId} went to ${task.claim?.by ?? "nobody"} on ${task.claim?.desk ?? "no desk"} — that claim ordered first and every desk agrees.\n\n${summarize(state, completeness)}`,
				);
			}
			return text(`Claimed ${taskId}.\n\n${summarize(state, completeness)}`);
		},
	);

	server.registerTool(
		"board_reclaim",
		{
			description:
				"Take over a claim that has expired. Accepted only if the log says it expired — no desk's clock decides.",
			inputSchema: fromJsonSchema({
				type: "object",
				properties: {
					taskId: { type: "string" },
					by: { type: "string" },
					ttlMinutes: { type: "number" },
				},
				required: ["taskId", "by"],
				additionalProperties: false,
			}),
		},
		async (raw) => {
			const { taskId, by, ttlMinutes } = args<{
				taskId: string;
				by: string;
				ttlMinutes?: number;
			}>(raw);
			const ttl = Number(ttlMinutes ?? DEFAULT_TTL_MINUTES);
			const before = await current();
			const task = before.state.tasks.find((entry) => entry.taskId === taskId);
			if (!task?.claim) return text(`${taskId} is not claimed, so there is nothing to reclaim.`);
			const { state, completeness } = await write({
				op: "reclaim",
				taskId: String(taskId),
				by: String(by),
				supersedes: task.claim.opId,
				assertedAt: Date.now(),
				expiresAt: Date.now() + ttl * 60_000,
			});
			const after = state.tasks.find((entry) => entry.taskId === taskId);
			return text(
				after?.claim?.by === by
					? `Reclaimed ${taskId}.\n\n${summarize(state, completeness)}`
					: `${taskId} stays with ${after?.claim?.by} — the log does not say that claim expired.\n\n${summarize(state, completeness)}`,
			);
		},
	);

	server.registerTool(
		"board_complete",
		{
			description: "Mark a task done on the fleet board.",
			inputSchema: fromJsonSchema({
				type: "object",
				properties: { taskId: { type: "string" }, by: { type: "string" } },
				required: ["taskId", "by"],
				additionalProperties: false,
			}),
		},
		async (raw) => {
			const { taskId, by } = args<{ taskId: string; by: string }>(raw);
			const { state, completeness } = await write({
				op: "complete",
				taskId: String(taskId),
				by: String(by),
			});
			return text(`Completed ${taskId}.\n\n${summarize(state, completeness)}`);
		},
	);

	server.registerTool(
		"board_list",
		{
			description:
				"Every task on the fleet board, with a line saying how much of the room this desk can actually see.",
			inputSchema: fromJsonSchema({ type: "object", properties: {}, additionalProperties: false }),
		},
		async () => {
			const { state, completeness } = await current();
			return text(summarize(state, completeness));
		},
	);

	return server;
});

/* The upward door, opened once. A board with no bridge is still a working MCP
 * server — it just has no room to be a board in, and says so when asked. */
void (async () => {
	try {
		bridge = await ToadBridge.connect();
		if (!bridge) return;
		await bridge.openLog(LOG_ID);
		/* A mirror gaining bytes is the only news that changes the fold without
		 * this desk having done anything, so it is the one thing worth waking for
		 * — and the loser of a concurrent claim finds out here. */
		bridge.onLogChanged(() => {
			void current().catch(() => undefined);
		});
		await current();
	} catch (error) {
		console.error(`board: ${(error as Error).message}`);
	}
})();
