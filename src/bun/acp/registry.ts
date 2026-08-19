import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Backend } from "../../shared/types";
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
 * themselves, so an npx package translates for them while the locally
 * installed CLI supplies the actual agent and its login.
 *
 * The CLI here is a prerequisite, not a command. Treating it as one is how you
 * end up spawning `claude -y @some/package`, which claude rejects outright.
 *
 * The registry supplies the adapter version; `fallback` only covers a cold
 * cache with no network, so a first run offline still starts something.
 */
const ADAPTED_BACKENDS: Record<
	string,
	{ name: string; description: string; requires: string; setup: string; fallback: Launch }
> = {
	"claude-acp": {
		name: "Claude Code",
		description: "Anthropic's coding agent, through its ACP adapter.",
		requires: "claude",
		setup: "install Claude Code and run `claude /login`",
		fallback: { cmd: "npx", args: ["-y", "@agentclientprotocol/claude-agent-acp@0.69.0"] },
	},
	"codex-acp": {
		name: "Codex",
		description: "OpenAI's coding agent, through its ACP adapter.",
		requires: "codex",
		setup: "install the Codex CLI and run `codex login`",
		fallback: { cmd: "npx", args: ["-y", "@agentclientprotocol/codex-acp@1.4.0"] },
	},
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

function which(cmd: string): string | null {
	try {
		return Bun.which(cmd) ?? null;
	} catch {
		return null;
	}
}

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
			unavailableReason: found ? undefined : `needs ${meta.cmd} on PATH`,
			source: "builtin",
		});
	}

	for (const [id, meta] of Object.entries(ADAPTED_BACKENDS)) {
		// The adapter downloads on demand, so what has to already be here is the
		// CLI it drives — along with whatever login that CLI carries.
		const found = which(meta.requires);
		backends.set(id, {
			id,
			name: meta.name,
			description: meta.description,
			launch: launchFor(registry.get(id) ?? null) ?? meta.fallback,
			available: found !== null,
			unavailableReason: found ? undefined : `needs ${meta.requires} on PATH: ${meta.setup}`,
			source: "builtin",
		});
	}

	for (const [id, agent] of registry) {
		if (backends.has(id)) continue;
		const launch = launchFor(agent);
		const runner = launch ? which(launch.cmd) : null;
		backends.set(id, {
			id,
			name: agent.name ?? id,
			description: agent.description,
			launch: launch ?? undefined,
			available: launch !== null && runner !== null,
			unavailableReason: !launch
				? "distributed as a prebuilt binary, which Toad cannot install yet"
				: runner
					? undefined
					: `needs ${launch.cmd} on PATH`,
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
	if (!found) throw new Error(`${launch.cmd} not found on PATH.`);
	return { ...launch, cmd: found };
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
	if (adapted && !which(adapted.requires)) {
		throw new Error(
			`${adapted.name} needs ${adapted.requires} on PATH — ${adapted.setup}, then try again.`,
		);
	}

	const fromRegistry = launchFor(cachedAgent(backendId));
	if (fromRegistry) return locate(fromRegistry);
	if (adapted) return locate(adapted.fallback);

	throw new Error(
		`Backend "${backendId}" has no launch command available on this machine. ` +
			`Install its CLI, or pick a different backend.`,
	);
}
