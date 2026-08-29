import { afterEach, describe, expect, test } from "bun:test";
import { builtInTools } from "./shell";

/**
 * The Windows tool blackout: pi reads a supplied tool list twice — the
 * built-ins to start active, and an allowlist it also applies to custom tools.
 * Windows was the only platform naming anything, so it was the only platform
 * where every tool Toad supplies silently disappeared.
 */

const real = process.platform;
const pretend = (value: string) => Object.defineProperty(process, "platform", { value, configurable: true });

afterEach(() => pretend(real));

describe("the built-in tool list", () => {
	test("names nothing off Windows, so pi's defaults and the user's stand", () => {
		pretend("linux");
		expect(builtInTools(["hop_desk"])).toBeUndefined();
		pretend("darwin");
		expect(builtInTools(["hop_desk"])).toBeUndefined();
	});

	test("carries every custom tool alongside the Windows shell swap", () => {
		pretend("win32");
		const tools = builtInTools(["hop_desk", "list_desks", "message_teammate"]);
		expect(tools).toContain("powershell");
		expect(tools).toContain("read");
		// The allowlist has to name them or they are dropped from the session.
		expect(tools).toContain("hop_desk");
		expect(tools).toContain("list_desks");
		expect(tools).toContain("message_teammate");
	});

	test("still answers the shell axis when nothing custom is supplied", () => {
		pretend("win32");
		expect(builtInTools()).toContain("powershell");
	});
});
