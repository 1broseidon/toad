import type { GrantedDesktopInfo } from "../shared/types";
import { mobileIdentity, signMobilePayload } from "./node-identity";

/**
 * Joining the plane, and getting back into it.
 *
 * `joinAsNode` spends a pairing code once, for a membership; every desk the
 * grant names comes back as a row for the desktops list. `mintNodeSession`
 * is the everyday act — challenge, signature, ten minutes of upgrade rights
 * — run against whichever desk the phone is walking to. A desk too old to
 * answer these routes says so cleanly, and the caller falls back to the
 * legacy pairing it still serves.
 */

export type JoinedRoom = {
	ok: true;
	existing: boolean;
	desk: { nodeId: string; name: string };
	member: { nodeId: string; name: string; fingerprint: string; grant: string[] };
	desktops: GrantedDesktopInfo[];
};

export type JoinRefused = {
	ok: false;
	error: string;
	/** The desk predates mobile membership; legacy pairing still works. */
	unsupported?: boolean;
};

async function postJson(
	origin: string,
	path: string,
	body: unknown,
): Promise<{ status: number; body: Record<string, unknown> } | { unsupported: true } | null> {
	try {
		const res = await fetch(new URL(path, origin), {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});
		// An older desk serves the SPA for unknown paths — HTML with a 200 —
		// which is the one answer that means "this route does not exist here".
		const type = res.headers.get("content-type") ?? "";
		if (!type.includes("json")) return { unsupported: true };
		return { status: res.status, body: (await res.json()) as Record<string, unknown> };
	} catch {
		return null;
	}
}

/** Trades a one-time code for membership — or recognition, if already joined. */
export async function joinAsNode(code: string, origin: string): Promise<JoinedRoom | JoinRefused> {
	const node = await mobileIdentity();
	const at = Date.now();
	// Key order matters: the desk rebuilds { code, id, at } and verifies the
	// JSON text, so this object is built in exactly that order.
	const proof = await signMobilePayload("mobile-join", { code, id: node.id, at });
	const answer = await postJson(origin, "/node/join", { code, node, at, proof });
	if (!answer) return { ok: false, error: "Could not reach that desktop" };
	if ("unsupported" in answer) return { ok: false, error: "older desktop", unsupported: true };
	const body = answer.body;
	if (answer.status !== 200 || body.ok !== true) {
		return { ok: false, error: String(body.error ?? "That desktop refused the join") };
	}
	return body as unknown as JoinedRoom;
}

/**
 * Reachability, cheaply: a desk that answers the challenge ask is a desk
 * worth walking to. A desk that refuses — not yet synced this membership,
 * or not in the grant — is honestly unreachable for this phone either way.
 */
export async function probeDesk(origin: string, timeoutMs = 4_000): Promise<boolean> {
	try {
		const node = await mobileIdentity();
		const res = await fetch(new URL("/node/session", origin), {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ nodeId: node.id }),
			signal: AbortSignal.timeout(timeoutMs),
		});
		return res.status === 200 && (res.headers.get("content-type") ?? "").includes("json");
	} catch {
		return false;
	}
}

export type NodeSession = {
	ok: true;
	token: string;
	deviceId: string;
	desk: { nodeId: string; name: string };
	member: { nodeId: string; name: string; fingerprint: string; grant: string[] };
	desktops: GrantedDesktopInfo[];
};

export type SessionDenied = {
	ok: false;
	/** `unknown` and `revoked` mean the membership itself is gone from here. */
	reason: "unknown" | "revoked" | "not-granted" | "unreachable" | "unsupported" | "failed";
	error: string;
};

/** The challenge exchange against one desk. Network silence is `unreachable`. */
export async function mintNodeSession(origin: string): Promise<NodeSession | SessionDenied> {
	const node = await mobileIdentity();
	const ask = await postJson(origin, "/node/session", { nodeId: node.id });
	if (!ask) return { ok: false, reason: "unreachable", error: "Could not reach that desktop" };
	if ("unsupported" in ask) return { ok: false, reason: "unsupported", error: "older desktop" };
	if (ask.status !== 200 || ask.body.ok !== true) {
		const reason = ask.body.reason;
		return {
			ok: false,
			reason: reason === "unknown" || reason === "revoked" || reason === "not-granted"
				? reason
				: "failed",
			error: String(ask.body.error ?? "That desktop refused"),
		};
	}
	const challenge = String(ask.body.challenge ?? "");
	const desk = (ask.body.desk ?? {}) as { nodeId?: string };
	if (!challenge || typeof desk.nodeId !== "string") {
		return { ok: false, reason: "failed", error: "That desktop answered strangely" };
	}
	// Same rule as the join: { challenge, id, dst } in this exact order.
	const proof = await signMobilePayload("mobile-session", {
		challenge,
		id: node.id,
		dst: desk.nodeId,
	});
	const answer = await postJson(origin, "/node/session", { nodeId: node.id, challenge, proof });
	if (!answer) return { ok: false, reason: "unreachable", error: "Could not reach that desktop" };
	if ("unsupported" in answer) return { ok: false, reason: "unsupported", error: "older desktop" };
	if (answer.status !== 200 || answer.body.ok !== true) {
		return { ok: false, reason: "failed", error: String(answer.body.error ?? "refused") };
	}
	return answer.body as unknown as NodeSession;
}
