import { dirname } from "node:path";

/**
 * Node IPC / snapshot leftovers the packaged app can inherit from Electrobun's
 * launcher. A spawned `node` that sees `NODE_CHANNEL_FD` treats itself as a
 * cluster worker and aborts in `LoadSnapshotDataAndRun` (exit 134). Cursor's
 * native binary never loads Node, which is why only Claude/npx died in 0.1.0.
 */
const STRIP = new Set([
	"NODE_CHANNEL_FD",
	"NODE_UNIQUE_ID",
	"NODE_PENDING_PIPE_INSTANCES",
	"ELECTRON_RUN_AS_NODE",
]);

/**
 * Environment for a process that is not Toad — ACP adapters, MCP servers.
 *
 * Starts from the current process so PATH and credentials survive, then
 * removes launcher-only state: Node cluster fds, and `LD_LIBRARY_PATH`
 * entries Electrobun adds so *its* `.so` files resolve (including `.`).
 */
export function childEnv(extra?: Record<string, string | undefined>): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value === undefined) continue;
		if (STRIP.has(key)) continue;
		env[key] = value;
	}

	const libraries = cleanLibraryPath(env.LD_LIBRARY_PATH);
	if (libraries) env.LD_LIBRARY_PATH = libraries;
	else delete env.LD_LIBRARY_PATH;

	if (env.npm_node_execpath === process.execPath) delete env.npm_node_execpath;

	if (extra) {
		for (const [key, value] of Object.entries(extra)) {
			if (value === undefined) delete env[key];
			else env[key] = value;
		}
	}
	return env;
}

function cleanLibraryPath(value: string | undefined): string | undefined {
	if (!value) return undefined;
	const appBin = dirname(process.execPath);
	const kept = value.split(":").filter((entry) => entry.length > 0 && entry !== "." && entry !== appBin);
	return kept.length > 0 ? kept.join(":") : undefined;
}
