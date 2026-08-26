import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { SETTINGS_FILE } from "../paths";
import { getLastPersonaId, setLastPersonaId } from "./settings";

describe("lastPersonaId keys", () => {
	test("setLastPersonaId stores a bare id", () => {
		setLastPersonaId("node/abc");
		expect(getLastPersonaId()).toBe("abc");
		const written = JSON.parse(readFileSync(SETTINGS_FILE, "utf8")) as {
			lastPersonaId?: string;
		};
		expect(written.lastPersonaId).toBe("abc");
		expect(written.lastPersonaId).not.toContain("/");
	});
});
