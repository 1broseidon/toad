/**
 * The computer proxy must list tools without waking a container. That is
 * what lets a Toad Agent (and an ACP backend) attach `computer__*` on a
 * fresh machine before GHCR has been pulled.
 *
 * Run: bun hack/verify-computer-handshake.ts
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dataDir = mkdtempSync(join(tmpdir(), "toad-computer-handshake-"));
process.env.TOAD_DATA_DIR = dataDir;

const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { StreamableHTTPClientTransport } = await import(
	"@modelcontextprotocol/sdk/client/streamableHttp.js"
);
const { createPersona, updatePersona } = await import("../src/bun/store/personas");
const { resolveMcpServers } = await import("../src/bun/mcp/servers");
const { containerName } = await import("../src/bun/computer/manager");
const { handshakeResponse, parseJsonRpc, COMPUTER_TOOLS } = await import("../src/bun/computer/surface");
const { resolveRuntime } = await import("../src/bun/computer/runtime");
const { ContainerDriver } = await import("../src/bun/computer/driver");

let passed = 0;
let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
	if (ok) passed++;
	else failed++;
	console.log(`  ${ok ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m"} ${name}${detail ? ` ${detail}` : ""}`);
};

console.log("\x1b[36mSurface\x1b[0m");
check("eight grouped tools", COMPUTER_TOOLS.length === 8, String(COMPUTER_TOOLS.length));
check(
	"names match the container contract",
	COMPUTER_TOOLS.map((t) => t.name).join(",") === "capture,input,browser,shell,files,windows,wait,state",
);
const listed = handshakeResponse(parseJsonRpc(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }))!);
check("tools/list is a local 200", listed?.status === 200);
const initialized = handshakeResponse({ jsonrpc: "2.0", method: "notifications/initialized" });
check("initialized is 202", initialized?.status === 202);
check("tools/call is not a handshake", handshakeResponse({ method: "tools/call", id: 2 }) === null);

console.log("\n\x1b[36mProxy handshake\x1b[0m");
const persona = createPersona({ name: "handshake", goal: "list tools without a machine" });
const enabled = updatePersona(persona.id, { computer: { enabled: true } });
const entry = resolveMcpServers(enabled).find((s) => s.name === "computer");
if (!entry || entry.type !== "http") throw new Error("no computer entry");

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

const client = new Client({ name: "verify-computer-handshake", version: "0.0.0" });
await client.connect(
	new StreamableHTTPClientTransport(new URL(entry.url), {
		requestInit: { headers: { Authorization: entry.headers?.Authorization ?? "" } },
	}),
);
const { tools } = await client.listTools();
check("SDK lists tools without a container", tools.length === 8, `${tools.length} tools`);
check("capture is present", tools.some((t) => t.name === "capture"));
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
