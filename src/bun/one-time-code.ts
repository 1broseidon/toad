import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * The one-time code a person reads off a desk.
 *
 * A phone pairing and an MCP client seat are the same ceremony — the desk shows
 * a short code, a human carries it, the door opens once — and `docs/client-seat.md`
 * says so outright. They had different postures anyway: the seat counted wrong
 * guesses and compared in constant time, the pairing did neither, so the door
 * that is *supposed* to become remotely reachable was the weaker of the two.
 * The discipline lives here now, once, so the two cannot drift apart again.
 *
 * What is deliberately *not* here is the window. Ten minutes for an operator
 * configuring an agent and two for a phone in the room are different promises
 * about different situations, so each caller keeps its own TTL and passes it in.
 *
 * In memory, one at a time, by both callers: a code that survives a restart is
 * a code nobody is watching, and a second code the desk is not showing is a
 * second way in the user did not open.
 */
export type OneTimeCode = {
	code: string;
	expiresAt: number;
	/** Wrong guesses so far. At `CODE_MAX_ATTEMPTS` the slot burns. */
	attempts: number;
};

/**
 * Guesses before the slot burns. 32 bits of code deserve a floor, not a race.
 *
 * Five is not a calibration against a particular window — it is the property
 * that survives the door moving. Unlimited guesses over a short window is a
 * defensible posture on a LAN and a different shape entirely once the door is
 * reachable from further away; five guesses stays five guesses wherever the
 * door ends up.
 */
export const CODE_MAX_ATTEMPTS = 5;

/** Four bytes of hex: short enough to read off a screen and type by hand. */
const CODE_BYTES = 4;

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

/**
 * Compares two codes without a timing oracle.
 *
 * Through digests rather than the codes themselves, which is what makes this
 * safe to hand an attacker-chosen string of any length: `timingSafeEqual`
 * throws on a length mismatch, and a length that decides between "throws" and
 * "returns false" is itself the oracle. Hashing first makes every comparison
 * the same fixed width.
 */
function codesEqual(a: string, b: string): boolean {
	const left = Buffer.from(sha256(a));
	const right = Buffer.from(sha256(b));
	return left.length === right.length && timingSafeEqual(left, right);
}

/** A fresh code, with its guess budget reset. A new code replaces the old one. */
export function mintCode(ttlMs: number): OneTimeCode {
	return {
		code: randomBytes(CODE_BYTES).toString("hex"),
		expiresAt: Date.now() + ttlMs,
		attempts: 0,
	};
}

/** Whether a standing code's window has closed. */
export function codeExpired(pending: OneTimeCode | null, now = Date.now()): boolean {
	return !pending || pending.expiresAt <= now;
}

/**
 * Spends a standing code, or refuses and charges the attempt.
 *
 * Answers with what the caller should hold from here on rather than mutating
 * anything, because both callers keep their pending code in a variable of their
 * own and the whole point of a one-time code is that spending it is not
 * separable from clearing it. `keep` is null once the slot is gone — spent,
 * expired, or burned by the fifth wrong guess.
 */
export function spendCode(
	pending: OneTimeCode | null,
	offered: string,
	now = Date.now(),
): { ok: boolean; keep: OneTimeCode | null } {
	if (codeExpired(pending, now)) return { ok: false, keep: null };
	const standing = pending as OneTimeCode;
	if (!codesEqual(standing.code, offered)) {
		const attempts = standing.attempts + 1;
		return {
			ok: false,
			keep: attempts >= CODE_MAX_ATTEMPTS ? null : { ...standing, attempts },
		};
	}
	return { ok: true, keep: null };
}
