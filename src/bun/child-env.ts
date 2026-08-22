import { existsSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { basename, delimiter, dirname } from "node:path";

const PATH_MARKER = "__TOAD_LOGIN_PATH__";
const PATH_TIMEOUT_MS = 5_000;

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
 * Recover the PATH an interactive login shell gives this user.
 *
 * Finder, Launchpad and Linux desktop files do not launch applications from a
 * shell, so their PATH is usually only the operating-system directories. ACP
 * CLIs and MCP servers commonly live in ~/.local/bin, Homebrew, npm, bun, cargo
 * or a version-manager shim directory. Asking the user's own shell once at app
 * startup makes backend discovery match the terminal without wrapping every
 * child in a shell.
 *
 * Shell startup files are allowed to print. The marker lets us take only the
 * value emitted by our command, and the timeout keeps a broken prompt plugin
 * from holding the application open forever.
 *
 * The probe can still come back empty — no $SHELL in a Linux desktop session,
 * an rc file that errors out — so well-known install directories are merged
 * in afterwards either way. The shell's answer stays first so its ordering
 * (version managers shadowing system installs) is preserved.
 */
export async function restoreUserPath(): Promise<string> {
	const inherited = process.env.PATH ?? "";
	if (process.platform === "win32") return inherited;

	const discovered = await loginShellPath();
	const merged = mergePath(discovered, inherited, wellKnownBinDirs().join(delimiter));
	if (merged) process.env.PATH = merged;
	return process.env.PATH ?? inherited;
}

/** The PATH the user's own shell reports, or undefined when it cannot say. */
async function loginShellPath(): Promise<string | undefined> {
	let shell = process.env.SHELL;
	if (!shell) {
		try {
			shell = userInfo().shell ?? undefined;
		} catch {}
	}
	if (!shell) return undefined;

	const command = `printf '\\n${PATH_MARKER}%s\\n' "$PATH"`;
	const args =
		basename(shell) === "fish"
			? ["-l", "-i", "-c", command]
			: ["-ilc", command];

	try {
		const proc = Bun.spawn([shell, ...args], {
			stdin: "ignore",
			stdout: "pipe",
			stderr: "ignore",
		});
		const timer = setTimeout(() => proc.kill(), PATH_TIMEOUT_MS);
		const [output, code] = await Promise.all([
			new Response(proc.stdout).text(),
			proc.exited,
		]);
		clearTimeout(timer);
		if (code !== 0) return undefined;

		const marker = output.lastIndexOf(PATH_MARKER);
		if (marker < 0) return undefined;
		return output
			.slice(marker + PATH_MARKER.length)
			.split(/\r?\n/, 1)[0]
			?.trim();
	} catch {
		return undefined;
	}
}

/**
 * Directories agent CLIs commonly install into, on macOS and Linux, kept to
 * ones that exist on this machine. The safety net under the shell probe.
 */
export function wellKnownBinDirs(): string[] {
	const home = homedir();
	return [
		`${home}/.local/bin`,
		`${home}/bin`,
		`${home}/.bun/bin`,
		`${home}/.cargo/bin`,
		`${home}/.deno/bin`,
		`${home}/.volta/bin`,
		"/opt/homebrew/bin",
		"/usr/local/bin",
		"/home/linuxbrew/.linuxbrew/bin",
		"/snap/bin",
	].filter((dir) => existsSync(dir));
}

/**
 * PATH lookup that sees what restoreUserPath restored.
 *
 * Bun.which snapshots the environment at process start, so the login-shell
 * PATH written into process.env later is invisible to it — the exact bug this
 * module exists to fix. Passing PATH explicitly makes the lookup follow the
 * live value. Every availability check in Toad must use this, never bare
 * Bun.which.
 */
export function whichOnPath(cmd: string): string | null {
	try {
		return Bun.which(cmd, { PATH: process.env.PATH ?? "" }) ?? null;
	} catch {
		return null;
	}
}

/** Shell PATH first, inherited fallback second, with stable de-duplication. */
export function mergePath(...values: Array<string | undefined>): string {
	const seen = new Set<string>();
	for (const value of values) {
		for (const entry of value?.split(delimiter) ?? []) {
			if (entry) seen.add(entry);
		}
	}
	return [...seen].join(delimiter);
}

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
