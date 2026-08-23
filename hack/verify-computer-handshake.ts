/**
 * The computer proxy lists tools from a cached container handshake, not a
 * handwritten catalog. That is what lets a session attach before the
 * machine is awake — after one real wake has filled the cache.
 *
 * Run: bun hack/verify-computer-handshake.ts
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dataDir = mkdtempSync(join(tmpdir(), "toad-computer-handshake-"));
process.env.TOAD_DATA_DIR = dataDir;

const { Client, StreamableHTTPClientTransport } = await import("@modelcontextprotocol/client");
const { createPersona, updatePersona } = await import("../src/bun/store/personas");
const { resolveMcpServers } = await import("../src/bun/mcp/servers");
const { containerName, defaultImage } = await import("../src/bun/computer/manager");
const { saveHandshakeCache } = await import("../src/bun/computer/store");
const { cachedHandshake, parseJsonRpc } = await import("../src/bun/computer/cache");
const { resolveRuntime } = await import("../src/bun/computer/runtime");
const { ContainerDriver } = await import("../src/bun/computer/driver");

let passed = 0;
let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
	if (ok) passed++;
	else failed++;
	console.log(`  ${ok ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m"} ${name}${detail ? ` ${detail}` : ""}`);
};

const names = ["capture", "input", "browser", "shell", "files", "windows", "wait", "state"];
const fromContainer = {
	resultType: "complete",
	tools: names.map((name) => ({
		name,
		description: `container:${name}`,
		inputSchema: { type: "object" as const, properties: {} },
	})),
	ttlMs: 60_000,
	cacheScope: "public" as const,
};
const discover = {
	resultType: "complete",
	ttlMs: 60_000,
	cacheScope: "public" as const,
	supportedVersions: ["2026-07-28", "2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"],
	capabilities: { tools: { listChanged: true }, logging: {} },
	_meta: { "io.modelcontextprotocol/serverInfo": { name: "toad-computer", version: "0.2.0" } },
};
const initialize = {
	protocolVersion: "2026-07-28",
	capabilities: { tools: { listChanged: true }, logging: {} },
	serverInfo: { name: "toad-computer", version: "0.2.0" },
};

console.log("\x1b[36mCache, not a handwritten list\x1b[0m");
const image = defaultImage();
const seeded = {
	image,
	fetchedAt: Date.now(),
	ttlMs: 60_000,
	results: {
		"server/discover": discover,
		initialize,
		"tools/list": fromContainer,
	},
};
const listed = cachedHandshake(seeded, image, parseJsonRpc(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }))!);
check("tools/list is a cached 200", listed?.status === 200);
const body = listed ? ((await listed.json()) as { result?: { tools?: Array<{ description?: string }> } }) : {};
check(
	"descriptions come from the container blob",
	(body.result?.tools ?? []).every((t) => (t.description ?? "").startsWith("container:")),
);
const discovered = cachedHandshake(
	seeded,
	image,
	parseJsonRpc(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "server/discover" }))!,
);
check("server/discover is a cached 200", discovered?.status === 200);
const miss = cachedHandshake(undefined, image, parseJsonRpc(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }))!);
check("cache miss does not fabricate a list", miss === null);
const discoverMiss = cachedHandshake(
	{ ...seeded, results: { "tools/list": fromContainer } },
	image,
	parseJsonRpc(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "server/discover" }))!,
);
check("partial cache does not fabricate discover", discoverMiss === null);
const initialized = cachedHandshake(seeded, image, { jsonrpc: "2.0", method: "notifications/initialized" });
check("initialized is 202", initialized?.status === 202);
check("tools/call is not a handshake", cachedHandshake(seeded, image, { method: "tools/call", id: 2 }) === null);
const sse = parseJsonRpc('event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"ttlMs":1}}\n\n');
check("SSE from the container is a JSON-RPC result", sse?.result !== undefined && (sse.result as { ttlMs?: number }).ttlMs === 1);

console.log("\n\x1b[36mProxy handshake\x1b[0m");
const persona = createPersona({ name: "handshake", goal: "list tools without a machine" });
const enabled = updatePersona(persona.id, { computer: { enabled: true } });
const entry = resolveMcpServers(enabled).find((s) => s.name === "computer");
if (!entry || entry.type !== "http") throw new Error("no computer entry");
saveHandshakeCache(persona.id, seeded);

const naked = await fetch(entry.url, {
	method: "POST",
	headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
	body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
});
check("proxy refuses without the token", naked.status === 401, `status=${naked.status}`);

const get = await fetch(entry.url, {
	method: "GET",
	headers: { Authorization: entry.headers?.Authorization ?? "", accept: "text/event-stream" },
});
check("GET /mcp is 405 (no SSE door)", get.status === 405, `status=${get.status}`);

const client = new Client({ name: "verify-computer-handshake", version: "0.0.0" }, { versionNegotiation: { mode: "auto" } });
await client.connect(
	new StreamableHTTPClientTransport(new URL(entry.url), {
		requestInit: { headers: { Authorization: entry.headers?.Authorization ?? "" } },
	}),
);
const { tools } = await client.listTools();
check("SDK lists tools from the cache", tools.length === 8, `${tools.length} tools`);
check("capture is present", tools.some((t) => t.name === "capture"));
check(
	"proxy served the container descriptions",
	tools.every((t) => (t.description ?? "").startsWith("container:")),
);
await client.close();

let state = "absent";
try {
	const runtime = await resolveRuntime();
	const inspection = await new ContainerDriver(runtime).inspect(containerName(persona.id));
	state = inspection.exists ? (inspection.running ? "running" : "stopped") : "absent";
} catch {
	state = "absent";
}
check("handshake left the container absent", state === "absent", state);

rmSync(dataDir, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
