import { McpServer, fromJsonSchema } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
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

const REQUEST_TIMEOUT_MS = 20_000;

function requestTimeoutMs(method: string, params: Record<string, unknown>): number {
	// A subagent still waits on request_human; the parent path returns at once.
	if (method === "request_human" && params.wait === true) {
		const asked = typeof params.timeout === "number" ? params.timeout : 600;
		return (Math.min(Math.max(asked, 10), 3600) + 30) * 1000;
	}
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

serveStdio(() => {
	const server = new McpServer({ name: "toad", version: process.env.TOAD_APP_VERSION ?? "unknown" });
	for (const tool of TOAD_TOOLS) {
		server.registerTool(
			tool.name,
			{
				description: tool.description,
				inputSchema: fromJsonSchema(tool.inputSchema as Record<string, unknown>),
			},
			async (args) => {
				const params = (args ?? {}) as Record<string, unknown>;
				if (!validToadToolArgs(tool.name, params)) {
					return {
						content: [{ type: "text" as const, text: JSON.stringify({ ok: false, reason: "bad_params" }) }],
					};
				}
				try {
					const result = await bridge.request(tool.name, params);
					return {
						content: [{ type: "text" as const, text: formatToadToolOutput(tool.name, result) }],
					};
				} catch (error) {
					return {
						content: [{ type: "text" as const, text: formatToadToolError(error) }],
					};
				}
			},
		);
	}
	return server;
});
