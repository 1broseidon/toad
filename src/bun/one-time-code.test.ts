import { describe, expect, test } from "bun:test";
import { CODE_MAX_ATTEMPTS, codeExpired, mintCode, spendCode } from "./one-time-code";

const TTL = 60_000;

describe("minting", () => {
	test("a fresh code is eight hex characters with an unspent budget", () => {
		const minted = mintCode(TTL);
		expect(minted.code).toMatch(/^[0-9a-f]{8}$/);
		expect(minted.attempts).toBe(0);
		expect(minted.expiresAt).toBeGreaterThan(Date.now());
	});

	test("two codes in a row are not the same code", () => {
		const codes = new Set(Array.from({ length: 64 }, () => mintCode(TTL).code));
		expect(codes.size).toBe(64);
	});
});

describe("spending", () => {
	test("the right code opens the door once and takes the slot with it", () => {
		const pending = mintCode(TTL);
		const first = spendCode(pending, pending.code);
		expect(first.ok).toBe(true);
		// The slot is gone before the caller has done anything with the answer,
		// so no second path can spend the same code.
		expect(first.keep).toBeNull();
		expect(spendCode(first.keep, pending.code).ok).toBe(false);
	});

	test("a wrong guess is refused and charged", () => {
		const pending = mintCode(TTL);
		const wrong = spendCode(pending, "deadbeef");
		expect(wrong.ok).toBe(false);
		expect(wrong.keep?.attempts).toBe(1);
		// The code itself is untouched: a wrong guess costs a guess, not the code.
		expect(wrong.keep?.code).toBe(pending.code);
	});

	test("five wrong guesses burn the code, and the right one afterwards fails", () => {
		const minted = mintCode(TTL);
		let pending = minted as ReturnType<typeof mintCode> | null;
		for (let guess = 0; guess < CODE_MAX_ATTEMPTS; guess += 1) {
			expect(pending).not.toBeNull();
			pending = spendCode(pending, "00000000").keep;
		}
		expect(pending).toBeNull();
		expect(spendCode(pending, minted.code).ok).toBe(false);
	});

	test("the right code after four wrong ones still works", () => {
		const minted = mintCode(TTL);
		let pending = minted as ReturnType<typeof mintCode> | null;
		for (let guess = 0; guess < CODE_MAX_ATTEMPTS - 1; guess += 1) {
			pending = spendCode(pending, "00000000").keep;
		}
		expect(pending?.attempts).toBe(CODE_MAX_ATTEMPTS - 1);
		expect(spendCode(pending, minted.code).ok).toBe(true);
	});

	test("a fresh code resets the budget a burnt one spent", () => {
		let pending: ReturnType<typeof mintCode> | null = mintCode(TTL);
		for (let guess = 0; guess < CODE_MAX_ATTEMPTS; guess += 1) {
			pending = spendCode(pending, "00000000").keep;
		}
		expect(pending).toBeNull();
		const again = mintCode(TTL);
		expect(again.attempts).toBe(0);
		expect(spendCode(again, again.code).ok).toBe(true);
	});

	test("an expired code refuses without charging anything, and is gone", () => {
		const pending = mintCode(TTL);
		const late = Date.now() + TTL + 1;
		const spent = spendCode(pending, pending.code, late);
		expect(spent.ok).toBe(false);
		expect(spent.keep).toBeNull();
		expect(codeExpired(pending, late)).toBe(true);
		expect(codeExpired(pending, Date.now())).toBe(false);
		expect(codeExpired(null)).toBe(true);
	});

	test("nothing standing refuses everything", () => {
		expect(spendCode(null, "deadbeef")).toEqual({ ok: false, keep: null });
		expect(spendCode(null, "")).toEqual({ ok: false, keep: null });
	});
});

describe("the compare has no oracle to read", () => {
	/*
	 * The comparison runs over sha256 digests, not the codes. That is what lets
	 * an attacker-chosen string of any length be compared at all: timingSafeEqual
	 * throws on a length mismatch, and a length that decides between "throws" and
	 * "returns false" is itself the oracle — a louder one than any nanosecond
	 * difference in an eight-character compare.
	 *
	 * So the property under test is structural rather than statistical: every
	 * offered value, whatever its shape, takes the same path to the same kind of
	 * answer and costs exactly one attempt.
	 */
	const offerings = ["", "a", "0", "deadbeef", "x".repeat(10_000), "🙂🙂🙂", "00000000 "];

	test("any offered value is refused, never thrown on, and costs one guess", () => {
		for (const offered of offerings) {
			const pending = mintCode(TTL);
			const spent = spendCode(pending, offered);
			expect(spent.ok).toBe(false);
			expect(spent.keep?.attempts).toBe(1);
		}
	});

	test("where the guess goes wrong does not change what it costs", () => {
		const minted = mintCode(TTL);
		const firstWrong = `${minted.code[0] === "0" ? "1" : "0"}${minted.code.slice(1)}`;
		const lastWrong = `${minted.code.slice(0, -1)}${minted.code.at(-1) === "0" ? "1" : "0"}`;
		expect(firstWrong).not.toBe(minted.code);
		expect(lastWrong).not.toBe(minted.code);
		// No prefix short-circuit: a code wrong in the last character is refused
		// exactly as one wrong in the first, and the survivor is identical.
		expect(spendCode(minted, firstWrong)).toEqual(spendCode(minted, lastWrong));
	});

	test("a code equal to the real one only after truncation is still refused", () => {
		const minted = mintCode(TTL);
		expect(spendCode(minted, minted.code.slice(0, 4)).ok).toBe(false);
		expect(spendCode(minted, `${minted.code}0`).ok).toBe(false);
		expect(spendCode(minted, minted.code.toUpperCase()).ok).toBe(false);
	});
});
