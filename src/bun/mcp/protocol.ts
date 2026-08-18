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
	| "timeout"
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

export type BridgeMethod =
	| "hello"
	| "get_context"
	| "list_teammates"
	| "message_teammate"
	| "read_transcript"
	| "search_transcripts";

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
