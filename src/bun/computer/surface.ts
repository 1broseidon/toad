/**
 * The computer MCP surface as the session sees it before the container is
 * awake (docs/computer.md §The tool surface).
 *
 * Handshake methods (initialize, tools/list, ping) are answered here so a
 * teammate can start — and an ACP backend can attach — without paying a
 * first-time image pull. tools/call still goes through the proxy's wake
 * path. Keep the names and descriptions aligned with
 * computer/internal/mcptools/grouped.go.
 */

export type ComputerTool = {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
};

const desktop = {
	type: "string",
	description: "target desktop name (omit for local)",
};

export const COMPUTER_TOOLS: ComputerTool[] = [
	{
		name: "capture",
		description:
			"See the screen — the way in for NATIVE apps (web content reads better through the browser tool's text). Default returns a screenshot plus the accessibility tree as structured text: windows, interactive elements, roles, coordinates, values, states. mode=png saves a raw image instead, for visual inspection. Frames land in your conversation, so the human sees what you see.",
		inputSchema: {
			type: "object",
			properties: {
				desktop,
				mode: {
					type: "string",
					description: "tree (default): screenshot + accessibility tree as structured text; png: save a raw PNG and return its path",
				},
				path: { type: "string", description: "png mode only: optional file path, auto-generated if empty" },
			},
		},
	},
	{
		name: "input",
		description:
			"Drive the mouse, keyboard, and clipboard on the desktop — for NATIVE apps, with coordinates from capture. For anything in the web browser, prefer the browser tool instead: its text/click_ref act on the page directly and beat mousing a URL bar every time. type is per-character; paste sets the clipboard and presses Ctrl+V (use it for long text). batch runs a short scripted sequence of steps under one lock. Input is refused while a human is at the screen.",
		inputSchema: {
			type: "object",
			properties: {
				desktop,
				action: {
					type: "string",
					description:
						"one of: click, double_click, right_click, move, drag, scroll, type, key, paste, clipboard_read, clipboard_write, batch",
				},
				x: { type: "number" },
				y: { type: "number" },
				x2: { type: "number" },
				y2: { type: "number" },
				clicks: { type: "number" },
				text: { type: "string" },
				combo: { type: "string" },
				steps: { type: "array", items: { type: "object" } },
				stop_on_error: { type: "boolean" },
				settle_ms: { type: "number" },
				capture_after: { type: "string" },
				capture_on_error: { type: "boolean" },
			},
			required: ["action"],
		},
	},
	{
		name: "browser",
		description:
			"The managed Chromium, semantically. text returns the page as an accessibility snapshot with element refs — far cheaper than reading pixels — and click_ref/fill/select/check/hover act on those refs. Plus navigation, tabs, uploads, dialogs, and downloads.",
		inputSchema: {
			type: "object",
			properties: {
				desktop,
				action: {
					type: "string",
					description:
						"one of: navigate, text, links, eval, click_ref, fill, select, check, hover, tabs, tab_select, tab_new, tab_close, upload, dialog_accept, dialog_dismiss, downloads",
				},
				url: { type: "string" },
				js: { type: "string" },
				ref: { type: "string" },
				button: { type: "string" },
				text: { type: "string" },
				value: { type: "string" },
				uncheck: { type: "boolean" },
				index: { type: "number" },
				path: { type: "string" },
			},
			required: ["action"],
		},
	},
	{
		name: "shell",
		description:
			"Run commands. exec is synchronous — stdout, stderr, exit code, duration — and is the escape hatch for everything without a tool. launch starts a GUI app on the desktop (accessibility flags injected) and returns its PID.",
		inputSchema: {
			type: "object",
			properties: {
				desktop,
				action: { type: "string", description: "exec (default): run synchronously and return output; launch: start a desktop app and return its PID" },
				command: { type: "string", description: "program to run, e.g. ls, python3, bash; desktop app for launch" },
				args: { type: "array", items: { type: "string" } },
				cwd: { type: "string" },
				timeout: { type: "number" },
				max_output: { type: "number" },
			},
			required: ["command"],
		},
	},
	{
		name: "files",
		description:
			"Move files across the machine boundary. get downloads a file, put returns a single-use upload URL (POST the content to it within 60s), list shows a directory.",
		inputSchema: {
			type: "object",
			properties: {
				desktop,
				action: { type: "string", description: "one of: get, put, list" },
				path: { type: "string", description: "absolute path on the machine" },
				local_path: { type: "string" },
			},
			required: ["action", "path"],
		},
	},
	{
		name: "windows",
		description:
			"Manage desktop windows: list them with IDs and bounds, focus, close, maximize (or restore), or auto-tile the lot (browser left, others stacked right).",
		inputSchema: {
			type: "object",
			properties: {
				desktop,
				action: { type: "string", description: "one of: list, focus, close, maximize, tile" },
				window_id: { type: "string" },
				unmaximize: { type: "boolean" },
			},
			required: ["action"],
		},
	},
	{
		name: "wait",
		description:
			"Poll the screen until text appears. Returns when found or after timeout. Use after input or navigation to confirm the screen reached the state you expect.",
		inputSchema: {
			type: "object",
			properties: {
				desktop,
				text: { type: "string", description: "text to wait for on screen" },
				timeout: { type: "number", description: "max seconds to wait (default 10)" },
			},
			required: ["text"],
		},
	},
	{
		name: "state",
		description:
			"Durable machine state. control marks the desktop as human-driven: YOUR mutating tools are refused until release or expiry, and the dock shows it — it does not summon anyone or change what the human can do. To actually ask the human to act (credentials, 2FA), call the request_human teammate tool instead, which alerts them and waits. login_* saves and restores browser logins by name. snapshot_* archives and restores the home directory.",
		inputSchema: {
			type: "object",
			properties: {
				desktop,
				action: {
					type: "string",
					description:
						"one of: control, release, login_save, login_load, login_list, login_delete, snapshot_save, snapshot_load, snapshot_list, snapshot_delete",
				},
				name: { type: "string" },
				duration: { type: "number" },
			},
			required: ["action"],
		},
	},
];

const HANDSHAKE = new Set(["initialize", "notifications/initialized", "tools/list", "ping"]);

export function isHandshakeMethod(method: string): boolean {
	return HANDSHAKE.has(method);
}

type JsonRpc = {
	jsonrpc?: string;
	id?: unknown;
	method?: string;
	params?: { protocolVersion?: string };
};

export function parseJsonRpc(text: string): JsonRpc | null {
	try {
		const parsed = JSON.parse(text) as JsonRpc;
		return parsed && typeof parsed === "object" ? parsed : null;
	} catch {
		return null;
	}
}

function jsonRpcResult(id: unknown, result: unknown): Response {
	return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
		headers: { "content-type": "application/json" },
	});
}

/** Answer an MCP handshake locally so listing tools does not wake a machine. */
export function handshakeResponse(message: JsonRpc): Response | null {
	const method = message.method;
	if (!method || !isHandshakeMethod(method)) return null;
	if (method === "notifications/initialized") return new Response(null, { status: 202 });
	if (method === "ping") return jsonRpcResult(message.id, {});
	if (method === "initialize") {
		return jsonRpcResult(message.id, {
			protocolVersion: message.params?.protocolVersion ?? "2025-03-26",
			capabilities: { tools: {} },
			serverInfo: { name: "toad-computer", version: "0.1.0" },
		});
	}
	if (method === "tools/list") return jsonRpcResult(message.id, { tools: COMPUTER_TOOLS });
	return null;
}
