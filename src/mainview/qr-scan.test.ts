import { expect, test } from "bun:test";
import { codeFromQr, originFromAddress, originFromPairUrl } from "./qr-scan";

/**
 * The two readers here take input from a camera and from a keyboard, which
 * is to say from a stranger. What they agree an address is decides which
 * machine a token gets sent to, so the edges are worth pinning down.
 */

test("a pairing URL yields the code and the plain door beside it", () => {
	expect(originFromPairUrl("https://192.168.1.20:4681/?pair=abc123&http=4680")).toEqual({
		code: "abc123",
		origin: "http://192.168.1.20:4680",
	});
});

test("a pairing URL without a port falls back to the default door", () => {
	expect(originFromPairUrl("https://toad.local:9999/?pair=deadbeef")).toEqual({
		code: "deadbeef",
		origin: "http://toad.local:4680",
	});
});

test("a bare code names a desktop without saying where one is", () => {
	expect(originFromPairUrl("  deadbeef ")).toEqual({ code: "deadbeef", origin: null });
	expect(originFromPairUrl("not a code at all")).toBeNull();
});

test("the browser's reader only ever wanted the code", () => {
	expect(codeFromQr("https://10.0.0.4:4681/?pair=abc123&http=4680")).toBe("abc123");
	expect(codeFromQr("abc123")).toBe("abc123");
	expect(codeFromQr("https://example.com/")).toBeNull();
});

test("a typed address takes the default port, keeps a given one, forces http", () => {
	expect(originFromAddress("192.168.1.20")).toBe("http://192.168.1.20:4680");
	expect(originFromAddress(" 192.168.1.20:4681 ")).toBe("http://192.168.1.20:4681");
	expect(originFromAddress("http://192.168.1.20:4680")).toBe("http://192.168.1.20:4680");
	expect(originFromAddress("https://192.168.1.20:4681")).toBe("http://192.168.1.20:4681");
});

test("an empty or unparseable address is not an address", () => {
	expect(originFromAddress("")).toBeNull();
	expect(originFromAddress("   ")).toBeNull();
	expect(originFromAddress("who knows")).toBeNull();
	expect(originFromAddress("http://")).toBeNull();
});
