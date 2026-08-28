import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { MCP_CREDENTIALS_FILE, SETTINGS_FILE } from "../paths";
import { getSettings, updateSettings } from "../store/settings";
import { resolveMcpServers } from "./servers";

test("legacy static headers migrate out of settings and remain runtime-compatible", () => {
	const id = randomUUID();
	const secret = `Bearer ${randomUUID()}`;
	const before = getSettings().mcpServers;
	try {
		updateSettings({
			mcpServers: [
				...before,
				{
					id,
					type: "http",
					name: "legacy",
					url: "https://example.test/mcp",
					headers: { Authorization: secret },
				} as never,
			],
		});
		const stored = getSettings().mcpServers.find((server) => server.id === id);
		expect(stored).toEqual({
			id,
			type: "http",
			name: "legacy",
			url: "https://example.test/mcp",
			auth: { mode: "static", headerNames: ["Authorization"] },
		});
		expect(readFileSync(SETTINGS_FILE, "utf8")).not.toContain(secret);
		if (existsSync(`${SETTINGS_FILE}.bak`)) expect(readFileSync(`${SETTINGS_FILE}.bak`, "utf8")).not.toContain(secret);
		expect(readFileSync(MCP_CREDENTIALS_FILE, "utf8")).toContain(secret);

		const persona = {
			id: randomUUID(),
			mcpPolicy: { mode: "some" as const, serverIds: [id] },
		} as Parameters<typeof resolveMcpServers>[0];
		const runtime = resolveMcpServers(persona).find((server) => server.id === id);
		expect(runtime?.type === "http" ? runtime.headers?.Authorization : undefined).toBe(secret);
	} finally {
		updateSettings({ mcpServers: before });
	}
	expect(readFileSync(MCP_CREDENTIALS_FILE, "utf8")).not.toContain(secret);
});
