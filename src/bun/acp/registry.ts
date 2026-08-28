import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Backend } from "../../shared/types";
import { whichOnPath } from "../child-env";
import { CACHE_DIR, ensureLayout } from "../paths";

/**
 * The registry's published catalog: one request for every agent, carrying
 * names, descriptions, pinned versions and launch commands.
 *
 * Preferred over walking the GitHub repo, which cost a request per agent and
 * drew on the unauthenticated API's 60-per-hour budget shared with everything
 * else on the machine.
 */
const REGISTRY_URL = "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

type Launch = { cmd: string; args: string[]; env?: Record<string, string> };

/**
 * Backends whose own binary speaks ACP. Finding it on PATH is both the
 * availability check and the launch, because they are the same thing.
 *
 * The registry distributes these as downloadable archives, but a copy that is
 * already installed carries the user's login, so it wins.
 */
const NATIVE_BACKENDS: Record<string, { name: string; description: string; cmd: string; args: string[] }> = {
	cursor: {
		name: "Cursor",
		description: "Cursor's coding agent. Uses your existing Cursor login.",
		cmd: "cursor-agent",
		args: ["acp"],
	},
	opencode: {
		name: "opencode",
		description: "Open-source agent with resume and fork support.",
		cmd: "opencode",
		args: ["acp"],
	},
	gemini: {
		name: "Gemini CLI",
		description: "Google's coding agent.",
		cmd: "gemini",
		args: ["--acp"],
	},
};

/**
 * Backends reached through an adapter. These agents do not speak ACP
 * themselves, so an npm package translates for them.
 *
 * An adapter is a translator, not the agent. npm will fetch the shim on
 * demand, which is why it used to be reported as installed — but a shim with
 * nothing to translate for cannot run a turn, and offering it green sends the
 * user into a session that dies on the first prompt. See ADAPTER_CLIENT for
 * the pairing, and the availability rule it buys.
 *
 * The registry supplies the adapter version; `fallback` only covers a cold
 * cache with no network, so a first run offline still starts something.
 */
const ADAPTED_BACKENDS: Record<
	string,
	{ name: string; description: string; fallback: Launch }
> = {
	"claude-acp": {
		name: "Claude Code",
		description:
			"Anthropic's coding agent, through its ACP adapter. Uses your Claude Code login (`claude /login`) or ANTHROPIC_API_KEY.",
		fallback: { cmd: "npx", args: ["-y", "@agentclientprotocol/claude-agent-acp@0.69.0"] },
	},
	"codex-acp": {
		name: "Codex",
		description:
			"OpenAI's coding agent, through its ACP adapter. Uses your Codex login (`codex login`) or OPENAI_API_KEY.",
		fallback: { cmd: "npx", args: ["-y", "@agentclientprotocol/codex-acp@1.4.0"] },
	},
};

/**
 * Adapter backend → the client binary it drives, hand-maintained.
 *
 * Kept by hand and by name for the same reason `mcp/compat.ts` keeps its
 * attach list by hand: nothing in the published registry says whether an entry
 * is a self-contained agent or a shim over a CLI you were supposed to install
 * yourself, so the only honest source is someone having checked. An id absent
 * from this map is treated as self-contained — the conservative default for
 * agents Toad has not looked at, and the existing philosophy for the natives.
 *
 * Availability for a listed adapter is runner AND client: npm can always fetch
 * the shim, so the client on PATH is the whole question. A missing login is
 * still not a missing agent — that surfaces when the session starts, never as
 * "unavailable" here.
 */
const ADAPTER_CLIENT: Record<string, string> = {
	"claude-acp": "claude",
	"codex-acp": "codex",
};

/**
 * The built-in agent.
 *
 * Not a backend in the sense the rest of this file means it — there is nothing
 * to find on PATH, nothing to download, and no process to start. It is listed
 * alongside the others because "which agent is this teammate" is one question
 * however it is answered, and the picker should not have two kinds of answer.
 *
 */
export const PI_BACKEND_ID = "pi";

/**
 * What the built-in agent is called.
 *
 * The id stays `pi` — it is written into every persona's config and into the
 * session checkpoints keyed by backend, so it is an identifier and not a label.
 * This is the label, and it says Toad because that is what it is: the agent you
 * get without installing anything, as against the harnesses Toad drives.
 */
export const BUILT_IN_AGENT_NAME = "Toad Agent";

/** New teammates use the in-process agent unless the user picks another harness. */
export const DEFAULT_BACKEND_ID = PI_BACKEND_ID;

function piBackend(): Backend {
	return {
		id: PI_BACKEND_ID,
		name: BUILT_IN_AGENT_NAME,
		description: "Runs inside Toad. Starts instantly and uses your own model key.",
		available: true,
		source: "builtin",
	};
}

// Sees the restored login-shell PATH; bare Bun.which would not (it snapshots
// the environment at process start).
const which = whichOnPath;

type Runner = { package: string; args?: string[]; env?: Record<string, string> };

type RegistryAgent = {
	id: string;
	name?: string;
	version?: string;
	description?: string;
	distribution?: { npx?: Runner; uvx?: Runner; binary?: unknown };
};

type RegistryCache = { fetchedAt: number; agents: RegistryAgent[] };

const cacheFile = () => join(CACHE_DIR, "registry.json");

function readCache(): RegistryCache | null {
	try {
		if (!existsSync(cacheFile())) return null;
		const cached = JSON.parse(readFileSync(cacheFile(), "utf8")) as RegistryCache;
		return Array.isArray(cached.agents) ? cached : null;
	} catch {
		return null;
	}
}

/** The published catalog, cached for a day and served stale over nothing. */
async function fetchRegistry(refresh: boolean): Promise<RegistryAgent[]> {
	ensureLayout();
	const cached = readCache();
	if (!refresh && cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
		return cached.agents;
	}

	try {
		const res = await fetch(REGISTRY_URL, { signal: AbortSignal.timeout(10_000) });
		if (!res.ok) throw new Error(`registry ${res.status}`);
		const body = (await res.json()) as { agents?: RegistryAgent[] };
		const agents = (body.agents ?? []).filter((a) => typeof a?.id === "string");
		if (agents.length > 0) {
			writeFileSync(cacheFile(), JSON.stringify({ fetchedAt: Date.now(), agents }), "utf8");
		}
		return agents.length > 0 ? agents : (cached?.agents ?? []);
	} catch {
		return cached?.agents ?? [];
	}
}

function cachedAgent(id: string): RegistryAgent | null {
	return readCache()?.agents.find((a) => a.id === id) ?? null;
}

/**
 * How a registry entry is started, or null when Toad cannot start it.
 *
 * npx and uvx both fetch on demand, so they need no install step. Binary
 * distributions are archives to download, verify and unpack, which Toad does
 * not do — those are reported as unavailable rather than offered and then
 * failing at the moment someone tries to use them.
 */
function launchFor(agent: RegistryAgent | null): Launch | null {
	const npx = agent?.distribution?.npx;
	if (npx) return { cmd: "npx", args: ["-y", npx.package, ...(npx.args ?? [])], env: npx.env };

	const uvx = agent?.distribution?.uvx;
	if (uvx) return { cmd: "uvx", args: [uvx.package, ...(uvx.args ?? [])], env: uvx.env };

	return null;
}

/**
 * Availability for a backend whose runner Toad can already start: yes, unless
 * it is a known adapter and the client it drives is not on PATH.
 */
function clientState(id: string): Pick<Backend, "available" | "unavailableKind" | "unavailableReason"> {
	const client = ADAPTER_CLIENT[id];
	if (!client || which(client) !== null) return { available: true };
	return {
		available: false,
		unavailableKind: "client",
		unavailableReason: `needs the ${client} CLI on PATH`,
	};
}

export async function listBackends(refresh = false): Promise<Backend[]> {
	const backends = new Map<string, Backend>();
	const registry = new Map((await fetchRegistry(refresh)).map((a) => [a.id, a]));

	backends.set(PI_BACKEND_ID, piBackend());

	for (const [id, meta] of Object.entries(NATIVE_BACKENDS)) {
		const found = which(meta.cmd);
		backends.set(id, {
			id,
			name: meta.name,
			description: meta.description,
			launch: { cmd: meta.cmd, args: meta.args },
			available: found !== null,
			unavailableKind: found ? undefined : "runner",
			unavailableReason: found ? undefined : `needs ${meta.cmd} on PATH`,
			source: "builtin",
		});
	}

	for (const [id, meta] of Object.entries(ADAPTED_BACKENDS)) {
		// npm fetches the adapter on demand and Toad's own Bun runtime can
		// always run it (see bunx below), so the runner is never the question
		// here — only whether the client it translates for is installed.
		backends.set(id, {
			id,
			name: meta.name,
			description: meta.description,
			launch: launchFor(registry.get(id) ?? null) ?? meta.fallback,
			...clientState(id),
			source: "builtin",
		});
	}

	for (const [id, agent] of registry) {
		if (backends.has(id)) continue;
		const launch = launchFor(agent);
		// npm packages always run: npx when Node is installed, Toad's bundled
		// Bun otherwise. uvx has no such fallback, so it must be present.
		const runnable = launch !== null && (launch.cmd === "npx" || which(launch.cmd) !== null);
		backends.set(id, {
			id,
			name: agent.name ?? id,
			description: agent.description,
			launch: launch ?? undefined,
			...(runnable
				? clientState(id)
				: {
						available: false,
						unavailableKind: "runner" as const,
						unavailableReason: launch
							? `needs ${launch.cmd} on PATH`
							: "distributed as a prebuilt binary, which Toad cannot install yet",
					}),
			source: "registry",
		});
	}

	return [...backends.values()].sort((a, b) => {
		if (a.id === DEFAULT_BACKEND_ID) return -1;
		if (b.id === DEFAULT_BACKEND_ID) return 1;
		if (a.source !== b.source) return a.source === "builtin" ? -1 : 1;
		return a.name.localeCompare(b.name);
	});
}

/**
 * Absolute path for a launch, so spawning does not depend on what PATH the
 * process happened to inherit. An app opened from Finder gets a far smaller
 * PATH than the same app started from a shell, and `npx` in particular lives
 * somewhere that minimal PATH does not reach.
 */
function locate(launch: Launch): Launch {
	const found = which(launch.cmd);
	if (found) return { ...launch, cmd: found };
	if (launch.cmd === "npx") return bunx(launch);
	throw new Error(`${launch.cmd} not found on PATH.`);
}

/**
 * The same npm package run by Toad's own Bun runtime instead of npx.
 *
 * `bun x` is Bun's npx: it fetches the package into Bun's cache and runs its
 * bin. Toad IS a Bun binary, so this works on a machine with no Node install
 * at all — the fresh-Mac and bare-Linux case. npx still wins when present
 * (see locate) because the adapters are developed and tested against Node.
 * `-y` is npx's skip-the-install-prompt flag; bun x has no prompt to skip
 * and rejects the flag, so it is dropped.
 */
export function bunx(launch: Launch): Launch {
	return {
		...launch,
		cmd: process.execPath,
		args: ["x", ...launch.args.filter((arg) => arg !== "-y")],
	};
}

/**
 * Resolves the command for a backend. Reads the cached catalog rather than
 * fetching, because starting a session should never wait on the network.
 */
export async function resolveLaunch(backendId: string): Promise<Launch> {
	if (backendId === PI_BACKEND_ID) {
		throw new Error("The built-in agent does not launch a process.");
	}

	const native = NATIVE_BACKENDS[backendId];
	if (native) return locate({ cmd: native.cmd, args: native.args });

	const adapted = ADAPTED_BACKENDS[backendId];
	const fromRegistry = launchFor(cachedAgent(backendId));
	if (fromRegistry) return locate(fromRegistry);
	if (adapted) return locate(adapted.fallback);

	throw new Error(
		`Backend "${backendId}" has no launch command available on this machine. ` +
			`Install its CLI, or pick a different backend.`,
	);
}
