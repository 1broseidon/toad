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
 * Run:  TOAD_COMPUTER_TOKEN=<token> bun scripts/verify-computer.ts
 */

import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

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

const client = new Client({ name: "verify-computer", version: "0.0.0" }, { versionNegotiation: { mode: "auto" } });
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

section("Files");

const put = await client.callTool({
	name: "files",
	arguments: { action: "put", path: "/home/agent/workspace/probe.txt", content: "over-mcp" },
});
check("files put writes on the channel", !put.isError, textOf(put).slice(0, 60));
const got = await client.callTool({
	name: "files",
	arguments: { action: "get", path: "/home/agent/workspace/probe.txt" },
});
check("files get returns the bytes", textOf(got).includes("over-mcp"), textOf(got).slice(0, 60));

section("Shell: a daemon left behind does not stall the call");

// `cmd.Wait` used to block on the grandchild's copy of stdout for the daemon's
// whole life — while holding the machine's action lock.
const daemonStart = Date.now();
const daemon = await client.callTool({
	name: "shell",
	arguments: { command: "bash", args: ["-c", "sleep 20 >/dev/null 2>&1 & echo started"], timeout: 10 },
});
check("exec returns once its own process exits", !daemon.isError && textOf(daemon).includes("started"), textOf(daemon).slice(0, 60));
check("and does so promptly", Date.now() - daemonStart < 5_000, `${Date.now() - daemonStart}ms`);

section("Files: the advertised cap");

// A 5MB put used to die at the SDK's default 4MiB body cap before the tool ran.
const big = "x".repeat(5 * 1024 * 1024);
const bigPut = await client.callTool({
	name: "files",
	arguments: { action: "put", path: "/home/agent/workspace/big.txt", content: big },
});
check("files put accepts a 5MB body", !bigPut.isError, textOf(bigPut).slice(0, 60));

section("State: the control lease belongs to its holder");

const connectAs = async (holder: string) => {
	const c = new Client({ name: `verify-computer-${holder}`, version: "0.0.0" }, { versionNegotiation: { mode: "auto" } });
	await c.connect(
		new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
			requestInit: {
				headers: { ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}), "X-Computer-Holder": holder },
			},
		}),
	);
	return c;
};
const alice = await connectAs("verify-alice");
const mallory = await connectAs("verify-mallory");
const taken = await alice.callTool({ name: "state", arguments: { action: "control", duration: 60 } });
check("alice takes control", !taken.isError && textOf(taken).includes("verify-alice"), textOf(taken).slice(0, 80));
const blocked = await mallory.callTool({ name: "input", arguments: { action: "key", combo: "Escape" } });
check("mallory's input is refused by name", blocked.isError === true && textOf(blocked).includes("verify-alice"));
const stolen = await mallory.callTool({ name: "state", arguments: { action: "release" } });
check("mallory cannot release alice's lease", stolen.isError === true && textOf(stolen).includes("verify-alice"), textOf(stolen).slice(0, 80));
const stillHeld = await mallory.callTool({ name: "input", arguments: { action: "key", combo: "Escape" } });
check("lease survives the refused release", stillHeld.isError === true);
const released = await alice.callTool({ name: "state", arguments: { action: "release" } });
check("alice releases her own lease", !released.isError && textOf(released).includes('"released":true'), textOf(released).slice(0, 80));
const free = await mallory.callTool({ name: "input", arguments: { action: "key", combo: "Escape" } });
check("input flows again after release", !free.isError);
await alice.close();
await mallory.close();

// -- summary ----------------------------------------------------------------

console.log(`\n\x1b[${failed ? 31 : 32}m${passed} passed, ${failed} failed\x1b[0m`);
await client.close();
process.exit(failed ? 1 : 0);
