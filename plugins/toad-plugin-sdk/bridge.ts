/**
 * The Toad plugin SDK's upward door.
 *
 * A plugin has two doors and both already existed. **Downward** it is an
 * ordinary MCP stdio server and Toad is its client — that half needs no SDK at
 * all, because MCP already has one in every language. **Upward** it holds this:
 * one newline-delimited JSON connection over the unix socket Toad handed it in
 * `TOAD_BRIDGE_SOCKET`, authenticated with `TOAD_BRIDGE_TOKEN`.
 *
 * There is no npm package yet, deliberately. This is one dependency-free file
 * with no imports from the Toad tree, so a plugin author copies it, reads it in
 * five minutes, and can see exactly what their plugin is allowed to say. That
 * is worth more at this stage than a version number.
 *
 * What the room gives a plugin, and nothing else:
 *
 * - **`log`** — an owned append-only replicated log. Every desk owns its own
 *   copy and mirrors every other desk's. This is what carries what must survive
 *   a dark peer.
 * - **`emit` / `onEvent`** — fire and forget, for what nobody may rely on. Loss
 *   is total and permanent for a desk that is dark; `emit` answers with who it
 *   actually reached rather than a boolean that averages the room.
 * - **`desks` / `teammates`** — narrow room facts, when granted.
 *
 * Two things are deliberately absent. There is no ordering across logs: fold
 * your own, and write your own stamp if you need one (the board does, in about
 * twenty lines). And there is no way to write another desk's log — `append`
 * takes no owner, so a mirror can only ever hold what its owner shipped.
 */

export type BridgeError = { code: string; message: string };

export type LogCursors = {
	logId: string;
	streamId: string;
	/** This desk's own writing, or null before the log has been opened. */
	self: { nodeId: string; gen: number; bytes: number } | null;
	/** Every other desk whose writing has arrived here. */
	mirrors: Array<{ nodeId: string; gens: Record<string, { held: number; digest: string }>; bytes: number }>;
	/** Desks that run this plugin and whose writing has NOT arrived here. The
	 *  difference between these two lists is how a fold reports its own
	 *  completeness instead of quietly showing part of the room. */
	absent: Array<{ nodeId: string; name: string; reason: string }>;
};

export type DeskRow = {
	nodeId: string;
	name: string;
	self: boolean;
	linked: boolean;
	stale: boolean;
	plugins: Array<{ id: string; version: string }>;
};

/** An event that arrived from another desk. `from` is stamped by the receiving
 *  Toad from the authenticated peer and is a sibling of `payload`, never a
 *  field inside it — which is why a payload schema may not declare one. */
export type InboundEvent = {
	from: string;
	fromName: string;
	name: string;
	payload: Record<string, unknown>;
};

type Pending = {
	resolve(value: Record<string, unknown>): void;
	reject(error: Error): void;
	timer: ReturnType<typeof setTimeout>;
};

const FRAME_VERSION = 1;

export class ToadBridge {
	private socket?: Bun.Socket<{ buffer: string }>;
	private pending = new Map<number, Pending>();
	private nextId = 1;
	private eventListeners = new Set<(event: InboundEvent) => void>();
	private logListeners = new Set<(change: { streamId: string; from: string }) => void>();

	private constructor(
		readonly pluginId: string,
		readonly nodeId: string,
	) {}

	/**
	 * Connects and authenticates, or answers null when this process was not
	 * started by Toad with a bridge — which is a legitimate way to run a plugin
	 * (a bare `tools/list` against it from a terminal) and not an error.
	 */
	static async connect(): Promise<ToadBridge | null> {
		const path = process.env.TOAD_BRIDGE_SOCKET;
		const token = process.env.TOAD_BRIDGE_TOKEN;
		const pluginId = process.env.TOAD_PLUGIN_ID;
		if (!path || !token || !pluginId) return null;

		const client = new ToadBridge(pluginId, "");
		const socket = await Bun.connect<{ buffer: string }>({
			unix: path,
			data: { buffer: "" },
			socket: {
				open(open) {
					open.data = { buffer: "" };
				},
				data: (open, bytes) => client.onData(open, bytes),
				close: () => client.failAll(new Error("the Toad bridge closed")),
				error: () => client.failAll(new Error("the Toad bridge errored")),
			},
		});
		client.socket = socket;
		const hello = await client.call("hello", { token });
		return Object.assign(client, { nodeId: String(hello.nodeId ?? "") });
	}

	private onData(socket: Bun.Socket<{ buffer: string }>, bytes: Buffer): void {
		socket.data.buffer += bytes.toString("utf8");
		for (;;) {
			const newline = socket.data.buffer.indexOf("\n");
			if (newline === -1) return;
			const line = socket.data.buffer.slice(0, newline);
			socket.data.buffer = socket.data.buffer.slice(newline + 1);
			if (!line.trim()) continue;
			let frame: Record<string, unknown>;
			try {
				frame = JSON.parse(line) as Record<string, unknown>;
			} catch {
				continue;
			}
			/* A push has no id. Every bridge client written before pushes existed
			 * looks each frame up by id, finds nothing and skips it — which is the
			 * whole reason pushes could be added without a version bump. */
			if (typeof frame.push === "string") {
				this.onPush(frame.push, (frame.payload ?? {}) as Record<string, unknown>);
				continue;
			}
			const pending = this.pending.get(frame.id as number);
			if (!pending) continue;
			this.pending.delete(frame.id as number);
			clearTimeout(pending.timer);
			if (frame.ok) pending.resolve((frame.result ?? {}) as Record<string, unknown>);
			else {
				const error = frame.error as BridgeError | undefined;
				pending.reject(
					Object.assign(new Error(error?.message ?? "the bridge refused"), {
						code: error?.code ?? "internal",
					}),
				);
			}
		}
	}

	private onPush(name: string, payload: Record<string, unknown>): void {
		if (name === "plugin.event") {
			const event: InboundEvent = {
				from: String(payload.from ?? ""),
				fromName: String(payload.fromName ?? ""),
				name: String(payload.name ?? ""),
				payload: (payload.payload ?? {}) as Record<string, unknown>,
			};
			for (const listener of this.eventListeners) listener(event);
			return;
		}
		if (name === "plugin.log.changed") {
			const change = { streamId: String(payload.streamId ?? ""), from: String(payload.from ?? "") };
			for (const listener of this.logListeners) listener(change);
		}
	}

	private failAll(error: Error): void {
		for (const pending of this.pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(error);
		}
		this.pending.clear();
	}

	call(method: string, params: Record<string, unknown>, timeoutMs = 20_000): Promise<Record<string, unknown>> {
		const socket = this.socket;
		if (!socket) return Promise.reject(new Error("not connected to the Toad bridge"));
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`${method} timed out`));
			}, timeoutMs);
			this.pending.set(id, { resolve, reject, timer });
			socket.write(`${JSON.stringify({ v: FRAME_VERSION, id, method, params })}\n`);
		});
	}

	close(): void {
		this.socket?.end();
		this.socket = undefined;
	}

	/* ---------------------------------------------------------------- logs */

	/** Mints this desk's generation of a log and answers where its bytes end. */
	async openLog(logId: string): Promise<{ gen: number; offset: number; streamId: string }> {
		const result = await this.call("plugin.log.open", { logId });
		return {
			gen: Number(result.gen),
			offset: Number(result.offset),
			streamId: String(result.streamId),
		};
	}

	/**
	 * One line onto this desk's own log. There is no owner parameter: writing
	 * another desk's mirror is not something this API can express.
	 */
	async append(logId: string, line: unknown): Promise<{ gen: number; offset: number; size: number }> {
		const bytes = Buffer.from(`${JSON.stringify(line)}\n`, "utf8").toString("base64");
		const result = await this.call("plugin.log.append", { logId, bytes });
		return { gen: Number(result.gen), offset: Number(result.offset), size: Number(result.size) };
	}

	async cursors(logId: string): Promise<LogCursors> {
		return (await this.call("plugin.log.cursors", { logId })) as unknown as LogCursors;
	}

	async read(input: {
		logId: string;
		ownerNode: string;
		gen: number;
		from: number;
		len: number;
	}): Promise<{ text: string; eof: boolean }> {
		const result = await this.call("plugin.log.read", input);
		return {
			text: Buffer.from(String(result.data ?? ""), "base64").toString("utf8"),
			eof: result.eof === true,
		};
	}

	/* -------------------------------------------------------------- events */

	/** Answers who it actually reached. `missed` is permanent for this event. */
	async emit(
		name: string,
		payload: Record<string, unknown>,
		to?: string[],
	): Promise<{ delivered: string[]; missed: string[] }> {
		const result = await this.call("plugin.event.emit", { name, payload, ...(to ? { to } : {}) });
		return {
			delivered: (result.delivered ?? []) as string[],
			missed: (result.missed ?? []) as string[],
		};
	}

	onEvent(listener: (event: InboundEvent) => void): () => void {
		this.eventListeners.add(listener);
		return () => this.eventListeners.delete(listener);
	}

	/** A mirror gained bytes. The fold is yours to redo; Toad only says when. */
	onLogChanged(listener: (change: { streamId: string; from: string }) => void): () => void {
		this.logListeners.add(listener);
		return () => this.logListeners.delete(listener);
	}

	/* ---------------------------------------------------------- room facts */

	async desks(): Promise<DeskRow[]> {
		const result = await this.call("plugin.desks", {});
		return (result.desks ?? []) as DeskRow[];
	}

	async teammates(): Promise<Array<{ id: string; name: string; team?: string; backendId: string }>> {
		const result = await this.call("plugin.teammates", {});
		return (result.teammates ?? []) as Array<{
			id: string;
			name: string;
			team?: string;
			backendId: string;
		}>;
	}
}
