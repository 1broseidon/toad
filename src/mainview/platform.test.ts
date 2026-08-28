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
const { customChrome, fileManager, insetLights, nativeContextMenus, nativeMenuBar } =
	await import("./platform");

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

test("a host name that arrives dirty still names its desk", () => {
	/* The value is injected as source text by a process we do not own. A NUL,
	 * a newline or a stray space beside the name would otherwise match nothing
	 * and hand Windows a desk with no caption buttons and no menu. */
	for (const dirty of ["windows\u0000", " windows ", "\twindows\n", "Windows"]) {
		host(dirty);
		expect(customChrome()).toBe(true);
		expect(nativeMenuBar()).toBe(false);
		expect(fileManager()).toBe("File Explorer");
	}
	host("\u0000macos");
	expect(insetLights()).toBe(true);
});

test("a desk with no name we know impersonates none of them", () => {
	for (const unknown of ["", "win32", "freebsd", undefined]) {
		host(unknown);
		expect(customChrome()).toBe(false);
		expect(insetLights()).toBe(false);
		expect(nativeMenuBar()).toBe(false);
		expect(nativeContextMenus()).toBe(false);
		expect(fileManager()).toBe("the file manager");
	}
});

test("macOS keeps its inlaid lights; nobody else has them", () => {
	host("macos");
	expect(insetLights()).toBe(true);
	host("windows");
	expect(insetLights()).toBe(false);
	host("linux");
	expect(insetLights()).toBe(false);
});

test("only macOS has a menu bar outside the window; Windows keeps native right-click", () => {
	host("macos");
	expect(nativeMenuBar()).toBe(true);
	expect(nativeContextMenus()).toBe(true);
	/* The one this pair exists for: Windows draws the menu in the chrome strip
	 * and listens for its own accelerators, while right-click stays the
	 * system's — a frameless window loses the bar, not the pop-ups. */
	host("windows");
	expect(nativeMenuBar()).toBe(false);
	expect(nativeContextMenus()).toBe(true);
	host("linux");
	expect(nativeMenuBar()).toBe(false);
	expect(nativeContextMenus()).toBe(false);
});

test("a desk is offered the file manager it actually has", () => {
	host("macos");
	expect(fileManager()).toBe("Finder");
	host("windows");
	expect(fileManager()).toBe("File Explorer");
	host("linux");
	expect(fileManager()).toBe("Files");
});
