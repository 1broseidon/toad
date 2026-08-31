import { describe, expect, test } from "bun:test";
import type { DeskCapabilities, HarnessChoice } from "../../shared/types";
import { resolveHarness } from "./ladder";

/**
 * The matching ladder is pure, so these tests hand it worlds directly: every
 * rung matched, every rung refused, and the reporting rule — every rung's
 * verdict visible whether or not it decided anything.
 */

function desk(overrides?: Partial<DeskCapabilities>): DeskCapabilities {
	return {
		platform: "linux",
		arch: "x64",
		harnesses: [
			{ id: "pi", name: "Toad Agent", available: true },
			{ id: "cursor", name: "Cursor", available: true },
			{ id: "codex-acp", name: "Codex", available: false },
		],
		builtin: {
			authenticated: true,
			providers: ["anthropic"],
			models: ["anthropic/claude-4", "anthropic/claude-4-mini"],
		},
		capturedAt: 1_000,
		...overrides,
	};
}

const CURSOR: HarnessChoice = { backendId: "cursor" };
const CODEX: HarnessChoice = { backendId: "codex-acp" };
const PI_KNOWN: HarnessChoice = { backendId: "pi", modelId: "anthropic/claude-4" };
const PI_FOREIGN: HarnessChoice = { backendId: "pi", modelId: "openai/gpt-6" };

describe("resolveHarness", () => {
	test("exact rung: the current ACP harness is advertised available", () => {
		const result = resolveHarness({ current: CURSOR, destination: desk() });
		expect(result.rung).toBe("exact");
		if (result.rung === "unavailable") throw new Error("unreachable");
		expect(result.choice).toEqual(CURSOR);
	});

	test("exact rung: the built-in agent needs auth and the model, and has both", () => {
		const result = resolveHarness({ current: PI_KNOWN, destination: desk() });
		expect(result.rung).toBe("exact");
		if (result.rung === "unavailable") throw new Error("unreachable");
		expect(result.choice).toEqual(PI_KNOWN);
	});

	test("override rung: an unavailable exact falls to the configured override", () => {
		const result = resolveHarness({
			current: CODEX,
			override: CURSOR,
			roomDefault: PI_KNOWN,
			destination: desk(),
		});
		expect(result.rung).toBe("override");
		if (result.rung === "unavailable") throw new Error("unreachable");
		expect(result.choice).toEqual(CURSOR);
	});

	test("default rung: exact and override both refused, the room default runs", () => {
		const result = resolveHarness({
			current: CODEX,
			override: PI_FOREIGN,
			roomDefault: CURSOR,
			destination: desk(),
		});
		expect(result.rung).toBe("default");
		if (result.rung === "unavailable") throw new Error("unreachable");
		expect(result.choice).toEqual(CURSOR);
	});

	test("unavailable: nothing on the ladder runs there", () => {
		const result = resolveHarness({
			current: CODEX,
			override: PI_FOREIGN,
			destination: desk({ builtin: { authenticated: true, providers: [], models: [] } }),
		});
		expect(result.rung).toBe("unavailable");
	});

	test("unavailable: no override and no room default leaves only the exact rung", () => {
		const result = resolveHarness({ current: CODEX, destination: desk() });
		expect(result.rung).toBe("unavailable");
		expect(result.rungs.map((rung) => rung.rung)).toEqual([
			"exact",
			"override",
			"default",
			"plugins",
		]);
		expect(result.rungs.map((rung) => rung.ok)).toEqual([false, false, false, true]);
	});

	test("every rung is reported with a verdict, even past the first match", () => {
		const result = resolveHarness({
			current: CURSOR,
			override: CODEX,
			roomDefault: PI_KNOWN,
			destination: desk(),
		});
		expect(result.rung).toBe("exact");
		expect(result.rungs.map((rung) => rung.rung)).toEqual([
			"exact",
			"override",
			"default",
			"plugins",
		]);
		expect(result.rungs.map((rung) => rung.ok)).toEqual([true, false, true, true]);
		for (const rung of result.rungs) expect(rung.reason.length).toBeGreaterThan(0);
	});

	test("an unconfigured rung reports itself as unconfigured, not as a failure of the desk", () => {
		const result = resolveHarness({ current: CURSOR, destination: desk() });
		const override = result.rungs.find((rung) => rung.rung === "override");
		expect(override?.choice).toBeNull();
		expect(override?.reason).toContain("nothing configured");
	});

	test("a harness the desk never mentioned is refused by name", () => {
		const result = resolveHarness({
			current: { backendId: "opencode" },
			destination: desk(),
		});
		expect(result.rung).toBe("unavailable");
		expect(result.rungs[0]?.reason).toContain("opencode");
	});

	test("the built-in agent without a model pin needs only working auth", () => {
		const result = resolveHarness({
			current: { backendId: "pi" },
			destination: desk({ builtin: { authenticated: true, providers: ["x"], models: [] } }),
		});
		expect(result.rung).toBe("exact");
	});

	test("an unauthenticated built-in agent refuses even an advertised model list", () => {
		const result = resolveHarness({
			current: PI_KNOWN,
			destination: desk({
				builtin: { authenticated: false, providers: [], models: ["anthropic/claude-4"] },
			}),
		});
		expect(result.rung).toBe("unavailable");
		expect(result.rungs[0]?.reason).toContain("signed-in");
	});
	test("a signed-in provider carries a model its desk's catalog forgot", () => {
		/* The live room's own lesson: a desk whose zai catalog had gone stale
		 * still served the model fine, and a catalog miss must not strand a
		 * teammate on the far desk. */
		const result = resolveHarness({
			current: { backendId: "pi", modelId: "zai/glm-5.3" },
			destination: desk({
				builtin: { authenticated: true, providers: ["zai"], models: ["zai/glm-5.2"] },
			}),
		});
		expect(result.rung).toBe("exact");
		expect(result.rungs[0]?.reason).toContain("signed into zai");
	});

	test("a provider the desk never signed into is still a real refusal", () => {
		const result = resolveHarness({
			current: { backendId: "pi", modelId: "openai/gpt-9" },
			destination: desk({
				builtin: { authenticated: true, providers: ["zai"], models: ["zai/glm-5.2"] },
			}),
		});
		expect(result.rung).toBe("unavailable");
		expect(result.rungs[0]?.reason).toContain("not signed into openai");
	});
});

describe("the plugins rung", () => {
	const rung = (result: { rungs: Array<{ rung: string; ok: boolean; reason: string }> }) =>
		result.rungs.find((entry) => entry.rung === "plugins")!;

	test("a teammate that needs nothing says so, rather than saying nothing", () => {
		const result = resolveHarness({ current: CURSOR, destination: desk({ format: 1, plugins: [] }) });
		expect(result.rung).toBe("exact");
		expect(rung(result).ok).toBe(true);
		expect(rung(result).reason).toContain("needs no plugins");
	});

	test("a desk that has the plugin runs the teammate, whatever version it is on", () => {
		const result = resolveHarness({
			current: CURSOR,
			requiredPlugins: ["com.example.board"],
			destination: desk({
				format: 1,
				plugins: [{ id: "com.example.board", version: "9.9.9", state: "running" }],
			}),
		});
		expect(result.rung).toBe("exact");
		expect(rung(result).ok).toBe(true);
	});

	test("a desk without the plugin refuses the whole resolution and names it", () => {
		const result = resolveHarness({
			current: CURSOR,
			requiredPlugins: ["com.example.board"],
			destination: desk({ format: 1, plugins: [] }),
		});
		expect(result.rung).toBe("unavailable");
		// The harness itself was fine; the veto is the plugin and it says which.
		expect(result.rungs[0]?.ok).toBe(true);
		expect(rung(result).reason).toContain("com.example.board");
	});

	test("a desk too old to advertise plugins says that, and does not claim to lack them", () => {
		const result = resolveHarness({
			current: CURSOR,
			requiredPlugins: ["com.example.board"],
			destination: desk(),
		});
		expect(result.rung).toBe("unavailable");
		expect(rung(result).reason).toContain("too old to say");
		expect(rung(result).reason).not.toContain("does not have");
	});

	test("an installed-but-stopped plugin still satisfies the rung", () => {
		/* State is the destination desk's own problem and it restarts; absence is
		 * not. Refusing a hop over a plugin that is merely down would strand a
		 * teammate for a supervisor's backoff window. */
		const result = resolveHarness({
			current: CURSOR,
			requiredPlugins: ["com.example.board"],
			destination: desk({
				format: 1,
				plugins: [{ id: "com.example.board", version: "1.0.0", state: "stopped" }],
			}),
		});
		expect(result.rung).toBe("exact");
	});
});
