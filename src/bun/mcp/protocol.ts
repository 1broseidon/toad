export const BRIDGE_VERSION = 1 as const;
export const MAX_FRAME_BYTES = 1024 * 1024;

export type BridgeErrorCode =
	| "unauthenticated"
	| "unknown_method"
	| "bad_params"
	| "not_found"
	| "self_target"
	| "busy"
	| "depth_limit"
	| "cycle"
	| "backend_unavailable"
	| "unreachable"
	| "timeout"
	/** A grant said no. Distinct from `bad_params`: the request was well formed
	 *  and the answer is still no, which is a thing the caller must be able to
	 *  tell apart from having got the call wrong. */
	| "refused"
	| "internal";

export type BridgeScope =
	| { kind: "human"; personaId: string }
	| {
			kind: "peer";
			personaId: string;
			threadKey: string;
			callerId: string;
			targetId: string;
	  }
	/**
	 * A plugin's own connection, held per desk and not per session.
	 *
	 * It carries no `personaId` on purpose. A plugin is not acting for a
	 * teammate when it writes its log or emits an event — it is a desk-level
	 * process that outlives every session, and giving it a persona would make
	 * every teammate-scoped method on this bridge silently answerable to it.
	 * The absence is what makes `dispatch` split the two surfaces apart instead
	 * of trusting each handler to check.
	 */
	| { kind: "plugin"; pluginId: string };

/** Every scope that speaks for a teammate. The whole pre-plugin bridge. */
export type TeammateScope = Exclude<BridgeScope, { kind: "plugin" }>;

export type Chain = { id: string; depth: number; path: string[] };

/**
 * Every method the bridge answers, and nothing else.
 *
 * The union used to declare thirteen while `dispatch` handled seventeen, so
 * `request_human`, `search_thread`, `react`, `resume_chapter` and `new_chapter`
 * were reachable on the wire and invisible to the type — which is how a
 * "complete" list of what a teammate may do stops being complete without
 * anyone noticing. One array now, with the union derived from it, and
 * `dispatch` narrowing through `isBridgeMethod` before its switch: a method
 * added to one and not the other no longer compiles. Worth fixing before
 * anything new is added to the bridge, which the plugin patterns will do.
 *
 * `BridgeRequest.method` stays `string`, because the wire carries whatever a
 * caller sends and an unknown method is an answer, not a parse failure.
 */
export const BRIDGE_METHODS = [
	"hello",
	"get_context",
	"list_teammates",
	"message_teammate",
	"read_agent_thread",
	"read_transcript",
	"search_transcripts",
	"schedule",
	"loop",
	"list_schedules",
	"cancel_schedule",
	"list_desks",
	"hop_desk",
	"request_human",
	"search_thread",
	"react",
	"resume_chapter",
	"new_chapter",
	/* The plugin surface. Dotted names, and never a plugin id inside one: the
	 * plugin is identified by the connection it authenticated on, so a method
	 * name cannot be forged into another plugin's namespace by spelling. */
	"plugin.log.open",
	"plugin.log.append",
	"plugin.log.cursors",
	"plugin.log.read",
	"plugin.event.emit",
	"plugin.desks",
	"plugin.teammates",
] as const;

export function isBridgeMethod(value: string): value is BridgeMethod {
	return (BRIDGE_METHODS as readonly string[]).includes(value);
}

export type BridgeMethod = (typeof BRIDGE_METHODS)[number];

/** The methods only a plugin connection may call, and only a plugin one. */
export type PluginBridgeMethod = Extract<BridgeMethod, `plugin.${string}`>;
/** Everything else: the teammate bridge, as it was before plugins existed. */
export type TeammateBridgeMethod = Exclude<BridgeMethod, PluginBridgeMethod>;

/**
 * A predicate rather than a boolean, so `dispatch` narrows on it. Splitting the
 * two surfaces then makes each switch exhaustive over its own half, and a
 * method added to `BRIDGE_METHODS` and to neither switch does not compile.
 */
export function isPluginMethod(value: BridgeMethod): value is PluginBridgeMethod {
	return value.startsWith("plugin.");
}

export type BridgeRequest = {
	v: typeof BRIDGE_VERSION;
	id: number;
	method: BridgeMethod | string;
	params: Record<string, unknown>;
};

export type BridgeResponse =
	| { v: typeof BRIDGE_VERSION; id: number; ok: true; result: Record<string, unknown> }
	| {
			v: typeof BRIDGE_VERSION;
			id: number;
			ok: false;
			error: { code: BridgeErrorCode; message: string };
	  };

/**
 * A frame Toad sends without being asked.
 *
 * There is no `id`, which is the whole compatibility story: the client keeps a
 * map of in-flight request ids and looks each response up in it, so a frame
 * with no id finds nothing and is skipped. Every bridge client written before
 * pushes existed therefore ignores them without knowing they exist, and the
 * sidecar — the one client Toad does not control the deployment of — already
 * does exactly that.
 */
export type BridgePush = {
	v: typeof BRIDGE_VERSION;
	push: string;
	payload: Record<string, unknown>;
};

export function isPush(value: unknown): value is BridgePush {
	if (!value || typeof value !== "object") return false;
	const frame = value as Partial<BridgePush>;
	return frame.v === BRIDGE_VERSION && typeof frame.push === "string" && frame.payload !== null;
}

export function pushFrame(name: string, payload: Record<string, unknown>): BridgePush {
	return { v: BRIDGE_VERSION, push: name, payload };
}

export function isRequest(value: unknown): value is BridgeRequest {
	if (!value || typeof value !== "object") return false;
	const frame = value as Partial<BridgeRequest>;
	return (
		frame.v === BRIDGE_VERSION &&
		Number.isSafeInteger(frame.id) &&
		typeof frame.method === "string" &&
		frame.params !== null &&
		typeof frame.params === "object" &&
		!Array.isArray(frame.params)
	);
}

export function success(id: number, result: Record<string, unknown>): BridgeResponse {
	return { v: BRIDGE_VERSION, id, ok: true, result };
}

export function failure(
	id: number,
	code: BridgeErrorCode,
	message: string,
): BridgeResponse {
	return { v: BRIDGE_VERSION, id, ok: false, error: { code, message } };
}

/**
 * A socket write only accepts what currently fits in the kernel send buffer —
 * 8 KiB for unix streams on macOS — and reports the rest as unwritten. Frames
 * here run far past that (a transcript read is ~20 KB), so the remainder has to
 * be held and flushed on `drain` or the tail is lost and the peer waits on a
 * frame that never terminates. Both ends of the bridge write through this.
 */
export type Outbox = { outbox: Buffer | null };

/** A peer that stops reading must not grow this process's memory without bound. */
const MAX_OUTBOX_BYTES = 4 * 1024 * 1024;

export function sendFrame<State extends Outbox>(socket: Bun.Socket<State>, frame: string): void {
	const bytes = Buffer.from(frame, "utf8");
	const queued = socket.data.outbox;
	if (!queued) {
		push(socket, bytes);
		return;
	}
	if (queued.length + bytes.length > MAX_OUTBOX_BYTES) {
		socket.data.outbox = null;
		socket.terminate();
		return;
	}
	socket.data.outbox = Buffer.concat([queued, bytes]);
}

export function flushFrames<State extends Outbox>(socket: Bun.Socket<State>): void {
	const queued = socket.data.outbox;
	if (!queued) return;
	socket.data.outbox = null;
	push(socket, queued);
}

function push<State extends Outbox>(socket: Bun.Socket<State>, bytes: Buffer): void {
	const wrote = socket.write(bytes);
	if (wrote >= bytes.length) return;
	socket.data.outbox = bytes.subarray(Math.max(0, wrote));
}
