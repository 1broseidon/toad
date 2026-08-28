import { connect } from "node:tls";
import { certFingerprint, NODE_TLS_SERVERNAME, type NodeTlsPin, pinnedTlsOptions } from "./tls";

/**
 * How this desk dials another one on the node plane.
 *
 * The origin carries the scheme, and the scheme is the whole migration
 * story: a desk paired before node TLS is remembered as `http://…` and is
 * dialed plain; a desk that has a certificate advertises `https://…` and is
 * dialed pinned. There is no probing and no per-peer fallback ladder, because
 * there is nothing to guess — an origin is a fact both sides agreed on at
 * pairing, kept in fleet.json, and re-announced when it changes. A ladder
 * would also be a downgrade: "https failed, try http" is precisely the move
 * an attacker wants, and a desk that has a pin must never take it.
 *
 * The one place a scheme can be wrong is the very first contact, before any
 * pin exists. That is `learnPeerCertificate`, below.
 */

export function isSecureOrigin(origin: string): boolean {
	return origin.startsWith("https://");
}

export type PinnedInit = RequestInit & { tls?: { ca: string; servername: string } };

/**
 * `fetch` for one node-plane origin.
 *
 * An https origin with no pin is refused rather than downgraded: the caller
 * either holds the certificate this peer promised, or it has no business
 * claiming to have reached that peer.
 */
export function nodeFetch(
	url: string | URL,
	init: RequestInit,
	pin: NodeTlsPin | null,
): Promise<Response> {
	const target = typeof url === "string" ? url : url.toString();
	if (!isSecureOrigin(target)) return fetch(target, init);
	if (!pin) {
		return Promise.reject(new Error("no pinned certificate for that node"));
	}
	return fetch(target, { ...init, tls: pinnedTlsOptions(pin) } as PinnedInit);
}

/**
 * The certificate an origin is presenting right now, learned by handshaking
 * with it and reading the peer certificate off the socket.
 *
 * This is the pairing moment, and only the pairing moment. It is not trust on
 * its own — anyone on the path can present a certificate. What makes it safe
 * is what the caller does next: the pairing reply carries the peer's
 * `certFingerprint` INSIDE its Ed25519 signature, and the caller refuses the
 * pairing unless that signed fingerprint is the fingerprint of the
 * certificate learned here. A machine in the middle can present its own key,
 * but it cannot make the peer sign that key's fingerprint, so the mismatch
 * ends the pairing. The certificate is only ever used as a trust root for the
 * very requests whose answers prove it.
 *
 * Bun exposes no way to read the presented certificate back out of `fetch` or
 * `WebSocket`, so this is a `node:tls` handshake of its own, torn down
 * immediately. `rejectUnauthorized` is off for exactly this socket, which
 * carries no request and no secret — never for the process.
 */
export function learnPeerCertificate(
	origin: string,
	timeoutMs = 5_000,
): Promise<NodeTlsPin | null> {
	let url: URL;
	try {
		url = new URL(origin);
	} catch {
		return Promise.resolve(null);
	}
	if (url.protocol !== "https:") return Promise.resolve(null);
	const port = Number(url.port) || 443;
	return new Promise((resolve) => {
		let settled = false;
		const done = (pin: NodeTlsPin | null) => {
			if (settled) return;
			settled = true;
			resolve(pin);
		};
		let socket: ReturnType<typeof connect>;
		try {
			socket = connect(
				{
					host: url.hostname,
					port,
					servername: NODE_TLS_SERVERNAME,
					rejectUnauthorized: false,
				},
				() => {
					try {
						const peer = socket.getPeerCertificate(true) as { raw?: Buffer };
						const raw = peer?.raw;
						if (!raw || !Buffer.isBuffer(raw)) {
							done(null);
						} else {
							const body = raw.toString("base64").replace(/(.{64})/g, "$1\n").trimEnd();
							const pem = `-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----\n`;
							done({ fingerprint: certFingerprint(pem), cert: pem });
						}
					} catch {
						done(null);
					}
					socket.destroy();
				},
			);
		} catch {
			done(null);
			return;
		}
		socket.setTimeout(timeoutMs, () => {
			socket.destroy();
			done(null);
		});
		socket.on("error", () => {
			socket.destroy();
			done(null);
		});
		socket.on("close", () => done(null));
	});
}

/**
 * The one legitimate scheme change: a peer paired in the plain-http era whose
 * desk has since grown a certificate. Its stored origin says http, its
 * listener now refuses plaintext, and after a whole fleet upgrades no link
 * survives to carry the announcement — every dial in both directions dies
 * against a scheme nobody updated. The probe closes that gap.
 *
 * It is an upgrade ratchet, not a fallback ladder: it only ever moves a peer
 * http → https-pinned, it runs only while the wire is down, and it commits
 * nothing on its own authority — the learned certificate merely lets the
 * ordinary NodeLink dial proceed, and the Ed25519 handshake inside remains
 * the thing that proves the peer. A wrong pin yields a down wire, which is
 * what we already had.
 */
export async function probeTlsUpgrade(
	peer: { id: string; origin: string },
	candidates: string[],
): Promise<{ origin: string; fingerprint: string; cert: string } | null> {
	for (const candidate of candidates) {
		if (!isSecureOrigin(candidate)) continue;
		const pin = await learnPeerCertificate(candidate);
		if (!pin) continue;
		/* Sanity, not proof: the desk answering at this origin must at least
		 * claim the identity we are upgrading, over the very cert we just
		 * learned. Proof stays where it lives — the link handshake. */
		try {
			const response = await nodeFetch(
				`${candidate}/node/info`,
				{ signal: AbortSignal.timeout(5_000) },
				pin,
			);
			if (!response.ok) continue;
			const info = (await response.json()) as { id?: string };
			if (info?.id !== peer.id) continue;
		} catch {
			continue;
		}
		return { origin: candidate, fingerprint: pin.fingerprint, cert: pin.cert };
	}
	return null;
}
