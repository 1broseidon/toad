/**
 * End-to-end proof of the first-class computer capability, no UI involved:
 * runtime detection, per-persona container lifecycle (lazy create, idle
 * stop, hibernate rm, wake from every state), the wake-on-request proxy,
 * token auth, provisioning, and injection into resolveMcpServers.
 *
 * Drives the real modules under src/bun/computer/ against a real container,
 * inside a throwaway TOAD_DATA_DIR. Needs a local image (default
 * toad-computer:dev — build with `docker build -t toad-computer:dev computer/`).
 *
 * Run: bun hack/verify-computer-capability.ts
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The modules under test read these at import time, so set them first.
const dataDir = mkdtempSync(join(tmpdir(), "toad-computer-verify-"));
process.env.TOAD_DATA_DIR = dataDir;
process.env.TOAD_COMPUTER_IMAGE = process.env.TOAD_COMPUTER_IMAGE ?? "toad-computer:dev";
process.env.TOAD_COMPUTER_IDLE_STOP_MS = "4000";
process.env.TOAD_COMPUTER_HIBERNATE_MS = "12000";

const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { StreamableHTTPClientTransport } = await import(
	"@modelcontextprotocol/sdk/client/streamableHttp.js"
);
const { detectRuntimes, resolveRuntime } = await import("../src/bun/computer/runtime");
const { containerName, sweepComputers } = await import("../src/bun/computer/manager");
const { listComputerRecords } = await import("../src/bun/computer/store");
const { createPersona, updatePersona, deletePersona } = await import("../src/bun/store/personas");
const { resolveMcpServers } = await import("../src/bun/mcp/servers");

let passed = 0;
let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
	if (ok) passed++;
	else failed++;
	console.log(`  ${ok ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m"} ${name} ${detail}`);
};
const section = (title: string) => console.log(`\n\x1b[36m${title}\x1b[0m`);

const runtime = await resolveRuntime();
const docker = async (...args: string[]) => {
	const proc = Bun.spawn([runtime.cmd, ...args], { stdout: "pipe", stderr: "pipe" });
	const out = await new Response(proc.stdout).text();
	await proc.exited;
	return out.trim();
};

// -- detection --------------------------------------------------------------

section("Runtime detection");
const runtimes = await detectRuntimes();
check(
	"at least one runtime available",
	runtimes.some((r) => r.available),
	runtimes.map((r) => `${r.id}:${r.available ? (r.rootless ? "rootless" : "rootful") : "no"}`).join(" "),
);
check("available ranked first", runtimes[0]!.available);

// -- persona + injection ----------------------------------------------------

section("Injection");
const persona = createPersona({ name: "computer-verify", goal: "verify the computer" });
const name = containerName(persona.id);
check("no computer entry while disabled", resolveMcpServers(persona).every((s) => s.name !== "computer"));

// The recipe: provisioning must leave a mark outside the workspace mount, so
// finding it proves the script ran on the machine rather than the mount
// merely showing it.
writeFileSync(join(persona.cwd, "computer-provision.sh"), "touch /home/agent/.provisioned\n");

const enabled = updatePersona(persona.id, { computer: { enabled: true } });
const entry = resolveMcpServers(enabled).find((s) => s.name === "computer");
check("computer entry appears when enabled", Boolean(entry));
if (!entry || entry.type !== "http") throw new Error("no http computer entry — cannot continue");
check("entry points at the local proxy", entry.url.startsWith("http://127.0.0.1:"), entry.url);
const token = entry.headers?.Authorization ?? "";
check("entry carries a bearer token", token.startsWith("Bearer "));

const connect = async (auth = token) => {
	const client = new Client({ name: "verify-computer-capability", version: "0.0.0" });
	await client.connect(
		new StreamableHTTPClientTransport(new URL(entry.url), {
			requestInit: { headers: { Authorization: auth } },
		}),
	);
	return client;
};
// The exec tool spawns the command directly (no shell), so shell syntax
// goes through `sh -c` explicitly.
const execOn = async (client: InstanceType<typeof Client>, script: string) => {
	const result = await client.callTool({
		name: "shell",
		arguments: { command: "sh", args: ["-c", script] },
	});
	return (result.structuredContent as { stdout?: string })?.stdout?.trim() ?? "";
};
const containerState = async () => (await docker("inspect", "--format", "{{.State.Running}}", name)) || "absent";

// -- auth and cold wake -----------------------------------------------------

section("Wake from nothing (create + provision)");
const naked = await fetch(entry.url, {
	method: "POST",
	headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
	body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
});
check("proxy refuses without the token", naked.status === 401, `status=${naked.status}`);

let client = await connect();
const { tools } = await client.listTools();
check("tools listed through the proxy", tools.length > 0, `${tools.length} tools`);
check("container running after first call", (await containerState()) === "true");
check("workspace mounted", (await execOn(client, "ls /home/agent/workspace")).includes("computer-provision.sh"));
check(
	"provision script ran",
	(await execOn(client, "test -f /home/agent/.provisioned && echo yes")) === "yes",
);
await execOn(client, "touch /home/agent/.rw-layer-survives");
await client.close();

// -- idle stop, wake from stopped ------------------------------------------

section("Idle stop, wake from stopped");
await Bun.sleep(5_000);
await sweepComputers();
check("idle computer stopped (not removed)", (await containerState()) === "false");

client = await connect();
check(
	"wake from stopped keeps the rw layer",
	(await execOn(client, "test -f /home/agent/.rw-layer-survives && echo yes")) === "yes",
);
await client.close();

// -- hibernate, wake from nothing again ------------------------------------

section("Hibernate, wake re-provisions");
await Bun.sleep(13_000);
await sweepComputers();
check("hibernated computer removed", (await containerState()) === "absent");

client = await connect();
check(
	"rw layer gone after hibernation",
	(await execOn(client, "test -f /home/agent/.rw-layer-survives || echo gone")) === "gone",
);
check(
	"recipe re-grew the machine",
	(await execOn(client, "test -f /home/agent/.provisioned && echo yes")) === "yes",
);
await client.close();

// -- delete cleans up -------------------------------------------------------

section("Delete");
deletePersona(persona.id);
await Bun.sleep(2_000);
check("container removed with the teammate", (await containerState()) === "absent");
check("record forgotten", listComputerRecords().every((r) => r.personaId !== persona.id));

// -- report -----------------------------------------------------------------

await docker("rm", "-f", name).catch(() => "");
rmSync(dataDir, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
