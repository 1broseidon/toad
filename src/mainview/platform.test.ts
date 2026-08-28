import { expect, test } from "bun:test";

/**
 * The platform gates are three string comparisons, which is exactly why they
 * are worth a test: the host injects `"windows"`, node's `platform()` says
 * `"win32"`, and a gate written with the wrong one of those still compiles,
 * still passes review, and ships a Windows desk with no caption buttons.
 */

const host = (name: string | undefined) => {
	(globalThis as { window?: unknown }).window = {
		__electrobunPlatform: name,
		location: { search: "" },
	};
};

host("linux");
const { customChrome, insetLights, nativeMenus } = await import("./platform");

test("the custom title strip is drawn on the two platforms with no native one", () => {
	host("linux");
	expect(customChrome()).toBe(true);
	host("windows");
	expect(customChrome()).toBe(true);
	host("macos");
	expect(customChrome()).toBe(false);
});

test("node's spelling of Windows is not the host's", () => {
	host("win32");
	expect(customChrome()).toBe(false);
});

test("macOS keeps its inlaid lights; Windows keeps its native menus", () => {
	host("macos");
	expect(insetLights()).toBe(true);
	expect(nativeMenus()).toBe(true);
	host("windows");
	expect(insetLights()).toBe(false);
	expect(nativeMenus()).toBe(true);
	host("linux");
	expect(nativeMenus()).toBe(false);
});
