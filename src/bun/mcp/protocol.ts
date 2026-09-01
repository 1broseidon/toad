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
	  };

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
 * added to one and not the other no longer compiles.
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
	"ring_message",
	"resume_chapter",
	"new_chapter",
] as const;

export function isBridgeMethod(value: string): value is BridgeMethod {
	return (BRIDGE_METHODS as readonly string[]).includes(value);
}

export type BridgeMethod = (typeof BRIDGE_METHODS)[number];

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
