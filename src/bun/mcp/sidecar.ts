import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import {
	BRIDGE_VERSION,
	MAX_FRAME_BYTES,
	flushFrames,
	sendFrame,
	type BridgeRequest,
	type BridgeResponse,
	type Outbox,
} from "./protocol";
import {
	TOAD_TOOLS,
	formatToadToolError,
	formatToadToolOutput,
	validToadToolArgs,
} from "./tools";

type Pending = {
	resolve(value: Record<string, unknown>): void;
	reject(reason: Error): void;
	timer: ReturnType<typeof setTimeout>;
};

/* Most bridge handlers answer from local state on the main process, so they
 * should never take long — but if one somehow does (or the response frame is
 * lost), the promise must not hang forever: the MCP host wrapping this
 * server has its own timeout, and surfacing ours first gives the agent a
 * clear "timeout" reason instead of a bare host-level failure, and frees the
 * pending map entry either way. */
const REQUEST_TIMEOUT_MS = 20_000;

/*
 * Two methods genuinely wait on another mind and get their time:
 * message_teammate waits for a peer's whole turn, and request_human waits
 * for a person — its own `timeout` param (default 600s) is the wait, plus
 * margin so the bridge's verdict arrives before ours.
 */
function requestTimeoutMs(method: string, params: Record<string, unknown>): number {
	if (method === "request_human") {
		const asked = typeof params.timeout === "number" ? params.timeout : 600;
		return (Math.min(Math.max(asked, 10), 3600) + 30) * 1000;
	}
	if (method === "message_teammate") return 10 * 60_000;
	return REQUEST_TIMEOUT_MS;
}

type ClientState = Outbox & { buffer: string };

class BridgeClient {
	private socket?: Bun.Socket<ClientState>;
	private pending = new Map<number, Pending>();
	private nextId = 1;

	async connect(socketPath: string, token: string): Promise<void> {
		this.socket = await Bun.connect<ClientState>({
			unix: socketPath,
			data: { buffer: "", outbox: null },
			socket: {
				data: (socket, bytes) => this.onData(socket, bytes),
				drain: (socket) => flushFrames(socket),
				close: () => this.failAll(new Error("Toad bridge closed")),
				error: () => this.failAll(new Error("Toad bridge failed")),
			},
		});
		await this.request("hello", { token });
	}

	request(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
		if (!this.socket) return Promise.reject(new Error("Toad bridge is not connected"));
		const id = this.nextId++;
		const frame: BridgeRequest = { v: BRIDGE_VERSION, id, method, params };
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(Object.assign(new Error("Toad bridge did not respond in time"), { code: "timeout" }));
			}, requestTimeoutMs(method, params));
			this.pending.set(id, {
				resolve: (value) => {
					clearTimeout(timer);
					resolve(value);
				},
				reject: (error) => {
					clearTimeout(timer);
					reject(error);
				},
				timer,
			});
			sendFrame(this.socket!, `${JSON.stringify(frame)}\n`);
		});
	}

	private onData(socket: Bun.Socket<ClientState>, bytes: Buffer): void {
		socket.data.buffer += bytes.toString("utf8");
		if (!socket.data.buffer.includes("\n") && Buffer.byteLength(socket.data.buffer) > MAX_FRAME_BYTES) {
			socket.terminate();
			this.failAll(new Error("Toad bridge response was too large"));
			return;
		}
		for (;;) {
			const newline = socket.data.buffer.indexOf("\n");
			if (newline === -1) return;
			const line = socket.data.buffer.slice(0, newline);
			socket.data.buffer = socket.data.buffer.slice(newline + 1);
			let response: BridgeResponse;
			try {
				response = JSON.parse(line) as BridgeResponse;
			} catch {
				continue;
			}
			const pending = this.pending.get(response.id);
			if (!pending) continue;
			this.pending.delete(response.id);
			if (response.ok) pending.resolve(response.result);
			else pending.reject(Object.assign(new Error(response.error.message), { code: response.error.code }));
		}
	}

	private failAll(error: Error): void {
		for (const pending of this.pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(error);
		}
		this.pending.clear();
	}
}

const socketPath = process.env.TOAD_BRIDGE_SOCKET;
const token = process.env.TOAD_BRIDGE_TOKEN;
if (!socketPath || !token) process.exit(1);

const bridge = new BridgeClient();
await bridge.connect(socketPath, token);

const server = new Server(
	{ name: "toad", version: process.env.TOAD_APP_VERSION ?? "unknown" },
	{ capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [...TOAD_TOOLS] }));
server.setRequestHandler(CallToolRequestSchema, async (request) => {
	const name = request.params.name;
	const args = request.params.arguments ?? {};
	if (!validToadToolArgs(name, args)) {
		return {
			content: [{ type: "text" as const, text: JSON.stringify({ ok: false, reason: "bad_params" }) }],
			isError: false,
		};
	}
	try {
		const result = await bridge.request(name, args);
		return {
			content: [{ type: "text" as const, text: formatToadToolOutput(name, result) }],
			isError: false,
		};
	} catch (error) {
		return {
			content: [{ type: "text" as const, text: formatToadToolError(error) }],
			isError: false,
		};
	}
});

await server.connect(new StdioServerTransport());
