import { randomUUID } from "node:crypto";
import type {
	IncomingNodeRequestInfo,
	NodeIdentity,
	NodeInvite,
	NodeRequestStatus,
	OutgoingNodeRequestInfo,
} from "../../shared/types";
import { createFleetInvite, joinFleet } from "../fleet/fleet";
import { learnPeerCertificate, nodeFetch } from "./dial";
import { isNodeIdentity, nodeIdentity, signNodePayload, verifyNodePayload } from "./identity";

const REQUEST_MS = 2 * 60_000;
const DEFAULT_NODE_PORT = Number(process.env.TOAD_NODE_PORT) || 4681;
const MAX_INCOMING = 64;
const MAX_OUTGOING = 64;

type RequestPayload = {
	id: string;
	node: NodeIdentity;
	origin: string;
	code: string;
	requestedAt: number;
	expiresAt: number;
	proof: string;
};

type IncomingRecord = {
	payload: RequestPayload;
	status: NodeRequestStatus;
	error?: string;
};

type OutgoingRecord = OutgoingNodeRequestInfo & {
	targetName: string;
};

const incoming = new Map<string, IncomingRecord>();
const outgoing = new Map<string, OutgoingRecord>();

function requestProof(payload: Omit<RequestPayload, "proof">): Omit<RequestPayload, "proof"> {
	return {
		id: payload.id,
		node: payload.node,
		origin: payload.origin,
		code: payload.code,
		requestedAt: payload.requestedAt,
		expiresAt: payload.expiresAt,
	};
}

function expire(): void {
	const now = Date.now();
	for (const record of incoming.values()) {
		if (record.status === "pending" && record.payload.expiresAt <= now) record.status = "expired";
	}
	for (const record of outgoing.values()) {
		if (record.status === "pending" && record.expiresAt <= now) record.status = "expired";
	}
}

function normalizeOrigin(input: string): string | null {
	try {
		/* A bare host stays plain. The scheme is something a desk advertises
		 * about itself and carries through discovery and pairing verbatim; a
		 * typed-in address must not silently promote itself into a plane whose
		 * certificate nobody has agreed to. */
		const url = new URL(input.includes("://") ? input : `http://${input}`);
		if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
			return null;
		}
		if (!url.port) url.port = String(DEFAULT_NODE_PORT);
		url.pathname = "/";
		url.search = "";
		url.hash = "";
		return url.origin;
	} catch {
		return null;
	}
}

export function handleIncomingNodeRequest(body: unknown): { status: number; body: unknown } {
	expire();
	const input = body as Partial<RequestPayload>;
	if (
		typeof input.id !== "string" ||
		!isNodeIdentity(input.node) ||
		typeof input.origin !== "string" ||
		typeof input.code !== "string" ||
		typeof input.requestedAt !== "number" ||
		typeof input.expiresAt !== "number" ||
		typeof input.proof !== "string"
	) {
		return { status: 400, body: { error: "bad request" } };
	}
	const origin = normalizeOrigin(input.origin);
	const now = Date.now();
	if (
		!origin ||
		input.node.id === nodeIdentity().id ||
		input.code.length > 128 ||
		input.requestedAt > now + 30_000 ||
		input.expiresAt <= now ||
		input.expiresAt - input.requestedAt > REQUEST_MS
	) {
		return { status: 400, body: { error: "invalid request" } };
	}
	const payload: RequestPayload = {
		id: input.id,
		node: input.node,
		origin,
		code: input.code,
		requestedAt: input.requestedAt,
		expiresAt: input.expiresAt,
		proof: input.proof,
	};
	if (!verifyNodePayload(payload.node, "node-request", requestProof(payload), payload.proof)) {
		return { status: 403, body: { error: "bad identity proof" } };
	}

	for (const [id, record] of incoming) {
		if (record.status === "pending" && record.payload.node.id === payload.node.id) incoming.delete(id);
	}
	while (incoming.size >= MAX_INCOMING) {
		const oldest = incoming.keys().next().value as string | undefined;
		if (!oldest) break;
		incoming.delete(oldest);
	}
	incoming.set(payload.id, { payload, status: "pending" });
	return {
		status: 202,
		body: { ok: true, id: payload.id, statusUrl: `/node/request/${encodeURIComponent(payload.id)}` },
	};
}

export function nodeRequestStatus(id: string): { status: number; body: unknown } {
	expire();
	const record = incoming.get(id);
	if (!record) return { status: 404, body: { error: "request not found" } };
	return {
		status: 200,
		body: {
			id,
			status: record.status,
			...(record.error ? { error: record.error } : {}),
		},
	};
}

export function listIncomingNodeRequests(): IncomingNodeRequestInfo[] {
	expire();
	return [...incoming.values()]
		.filter((record) => record.status === "pending")
		.map(({ payload }) => ({
			id: payload.id,
			node: {
				id: payload.node.id,
				name: payload.node.name,
				fingerprint: payload.node.fingerprint,
				protocol: payload.node.protocol,
				capabilities: payload.node.capabilities,
			},
			origin: payload.origin,
			requestedAt: payload.requestedAt,
			expiresAt: payload.expiresAt,
		}));
}

export async function decideNodeRequest(
	id: string,
	decision: "accept" | "deny",
): Promise<{ ok: boolean; error?: string }> {
	expire();
	const record = incoming.get(id);
	if (!record || record.status !== "pending") return { ok: false, error: "That request is no longer pending" };
	if (decision === "deny") {
		record.status = "denied";
		return { ok: true };
	}
	const joined = await joinFleet({ origin: record.payload.origin, code: record.payload.code });
	if (!joined.ok) {
		record.status = "failed";
		record.error = joined.error;
		return { ok: false, error: joined.error };
	}
	record.status = "accepted";
	return { ok: true };
}

export async function requestNearbyNode(input: {
	nodeId: string;
	name: string;
	origin: string;
}): Promise<{ ok: boolean; requestId?: string; error?: string }> {
	const targetOrigin = normalizeOrigin(input.origin);
	if (!targetOrigin) return { ok: false, error: "That node has an invalid address" };
	const invite = createFleetInvite(input.nodeId);
	if ("error" in invite) return { ok: false, error: invite.error };

	const identity = nodeIdentity();
	const requestedAt = Date.now();
	const payload = {
		id: randomUUID(),
		node: identity,
		origin: invite.origin,
		code: invite.code,
		requestedAt,
		expiresAt: requestedAt + REQUEST_MS,
	};
	const record: OutgoingRecord = {
		id: payload.id,
		nodeId: input.nodeId,
		targetName: input.name,
		origin: targetOrigin,
		status: "pending",
		requestedAt,
		expiresAt: payload.expiresAt,
	};
	while (outgoing.size >= MAX_OUTGOING) {
		const oldest = outgoing.keys().next().value as string | undefined;
		if (!oldest) break;
		outgoing.delete(oldest);
	}
	outgoing.set(payload.id, record);

	try {
		/* Asking to be let in happens before either desk has pinned the other,
		 * so there is nothing to enforce yet: the certificate presented right
		 * now is used as the trust root for this one request. What it buys is
		 * confidentiality for the invite code inside — the authentication is
		 * the Ed25519 proof, and the pin is settled a moment later in
		 * /fleet/pair, where the peer must sign the fingerprint it serves. */
		const pin = await learnPeerCertificate(targetOrigin);
		const response = await nodeFetch(new URL("/node/request", targetOrigin), {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				...payload,
				proof: signNodePayload("node-request", payload),
			}),
			signal: AbortSignal.timeout(10_000),
		}, pin);
		if (!response.ok) {
			const body = (await response.json().catch(() => null)) as { error?: string } | null;
			record.status = "failed";
			record.error = body?.error ?? `That desktop answered ${response.status}`;
			return { ok: false, requestId: payload.id, error: record.error };
		}
		return { ok: true, requestId: payload.id };
	} catch {
		record.status = "failed";
		record.error = "Could not reach that desktop";
		return { ok: false, requestId: payload.id, error: record.error };
	}
}

async function refreshOutgoing(): Promise<void> {
	expire();
	await Promise.all(
		[...outgoing.values()]
			.filter((record) => record.status === "pending")
			.map(async (record) => {
				try {
					const pin = await learnPeerCertificate(record.origin, 2_000);
					const response = await nodeFetch(
						new URL(`/node/request/${encodeURIComponent(record.id)}`, record.origin),
						{ signal: AbortSignal.timeout(2_000) },
						pin,
					);
					if (!response.ok) return;
					const body = (await response.json()) as { status?: NodeRequestStatus; error?: string };
					if (body.status) record.status = body.status;
					if (body.error) record.error = body.error;
				} catch {
					// The request remains pending until its own expiry. Discovery
					// may be healthy while the target is between listener restarts.
				}
			}),
	);
}

export async function listOutgoingNodeRequests(): Promise<OutgoingNodeRequestInfo[]> {
	await refreshOutgoing();
	return [...outgoing.values()].map(({ targetName: _targetName, ...record }) => ({ ...record }));
}

export function createNodeInvite(): NodeInvite | { error: string } {
	const invite = createFleetInvite();
	if ("error" in invite) return invite;
	return { ...invite, expiresAt: Date.now() + REQUEST_MS };
}

export async function joinNodeInvite(
	origin: string,
	code: string,
): Promise<{ ok: true; peer: { id: string; name: string } } | { ok: false; error: string }> {
	const normalized = normalizeOrigin(origin);
	if (!normalized) return { ok: false, error: "Enter a valid desktop address" };
	if (!code.trim()) return { ok: false, error: "Enter the one-time token" };
	return joinFleet({ origin: normalized, code: code.trim() });
}
