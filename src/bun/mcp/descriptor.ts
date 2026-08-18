import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import packageInfo from "../../../package.json" with { type: "json" };
import { bridgeAttachmentEnabled } from "./bridge";

type DescriptorInput = { personaId: string; token: string };

function sidecarEntry(): string | undefined {
	const here = dirname(fileURLToPath(import.meta.url));
	const candidates = [
		join(here, "sidecar.js"),
		join(here, "..", "mcp", "sidecar.js"),
		join(process.cwd(), "dist", "mcp-sidecar.js"),
		join(process.cwd(), "src", "bun", "mcp", "sidecar.ts"),
	];
	return candidates.find(existsSync);
}

/** The ACP stdio descriptor for Toad's bundled MCP server. */
export function sidecarDescriptor(input: DescriptorInput): Record<string, unknown> | undefined {
	if (!bridgeAttachmentEnabled()) return undefined;
	const entry = sidecarEntry();
	if (!entry) return undefined;
	return {
		name: "toad",
		command: process.execPath,
		args: [entry],
		env: [
			{ name: "TOAD_BRIDGE_SOCKET", value: bridgeAttachmentEnabled() ?? "" },
			{ name: "TOAD_BRIDGE_TOKEN", value: input.token },
			{ name: "TOAD_PERSONA_ID", value: input.personaId },
			{ name: "TOAD_APP_VERSION", value: packageInfo.version },
		],
	};
}
