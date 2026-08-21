/**
 * Drives a running toad-computer container over raw MCP, the way a teammate
 * will: streamable HTTP, bearer token, real tools. This is the v0 proof that
 * the contract works before the app knows containers exist.
 *
 * Expects the container up:
 *
 *   docker run -d --name toad-computer-test \
 *     --cap-drop=ALL --security-opt no-new-privileges \
 *     --memory 2g --pids-limit 512 --shm-size 1g \
 *     -p 127.0.0.1:8787:8787 -p 127.0.0.1:5999:5999 \
 *     -e TOAD_COMPUTER_TOKEN=<token> \
 *     toad-computer:dev
 *
 * Run:  TOAD_COMPUTER_TOKEN=<token> bun hack/verify-computer.ts
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const BASE = process.env.TOAD_COMPUTER_URL ?? "http://127.0.0.1:8787";
const TOKEN = process.env.TOAD_COMPUTER_TOKEN ?? "";

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail = "") {
	if (ok) passed++;
	else failed++;
	console.log(`  ${ok ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m"} ${name} ${detail}`);
}

function section(title: string) {
	console.log(`\n\x1b[36m${title}\x1b[0m`);
}

const textOf = (result: unknown): string => {
	const content = (result as { content?: Array<{ type: string; text?: string }> }).content ?? [];
	return content
		.filter((c) => c.type === "text")
		.map((c) => c.text ?? "")
		.join("\n");
};

// -- health, and the token actually being enforced --------------------------

section("Contract");

const health = await fetch(`${BASE}/health`);
check("/health answers without auth", health.ok, `status=${health.status}`);

const naked = await fetch(`${BASE}/mcp`, {
	method: "POST",
	headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
	body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
});
if (TOKEN) check("MCP refuses without the token", naked.status === 401, `status=${naked.status}`);
else console.log("  SKIP token enforcement (TOAD_COMPUTER_TOKEN not set)");

// -- connect the way Toad's http MCP config would ---------------------------

const client = new Client({ name: "verify-computer", version: "0.0.0" });
await client.connect(
	new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
		requestInit: TOKEN ? { headers: { Authorization: `Bearer ${TOKEN}` } } : undefined,
	}),
);

const { tools } = await client.listTools();
const names = tools.map((t) => t.name);
check("tools listed", tools.length > 0, `${tools.length} tools`);
// The grouped surface: eight nouns, small enough to read whole. A count much
// above that means the granular registration leaked into the default.
check("surface stays small", tools.length <= 10, `${tools.length} tools`);
for (const expected of ["capture", "input", "browser", "shell", "files", "windows", "wait", "state"]) {
	check(`tool: ${expected}`, names.includes(expected));
}

// -- see the empty desktop --------------------------------------------------

section("See");

const capture = await client.callTool({ name: "capture", arguments: {} });
const seen = textOf(capture);
check("capture returns structured text", seen.length > 0, `${seen.length} chars`);

const shot = await client.callTool({ name: "capture", arguments: { mode: "png" } });
check("capture mode=png produced", !shot.isError, textOf(shot).slice(0, 60));

// -- act: shell, then watch a window appear ---------------------------------

section("Act");

const shell = await client.callTool({
	name: "shell",
	arguments: { command: "bash", args: ["-c", "echo computer-says-$((6 * 7))"] },
});
check("shell runs a command", textOf(shell).includes("computer-says-42"), textOf(shell).trim().slice(0, 60));

const win = await client.callTool({
	name: "shell",
	arguments: {
		command: "bash",
		args: ["-c", "xterm -T proof -e 'sleep 30' >/dev/null 2>&1 & sleep 1; xdotool search --name proof | head -1"],
	},
});
const windowFound = /\d/.test(textOf(win));
check("a window can be opened and found", windowFound, textOf(win).trim().slice(0, 60));

const key = await client.callTool({ name: "input", arguments: { action: "key", combo: "Escape" } });
check("keyboard input accepted", !key.isError);

const click = await client.callTool({ name: "input", arguments: { action: "click", x: 400, y: 300 } });
check("mouse input accepted", !click.isError);

const bad = await client.callTool({ name: "input", arguments: { action: "warp" } });
check("unknown action names the real ones", bad.isError === true && textOf(bad).includes("click"));

// -- summary ----------------------------------------------------------------

console.log(`\n\x1b[${failed ? 31 : 32}m${passed} passed, ${failed} failed\x1b[0m`);
await client.close();
process.exit(failed ? 1 : 0);
