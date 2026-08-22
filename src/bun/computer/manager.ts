import { existsSync } from "node:fs";
import { join } from "node:path";
import packageInfo from "../../../package.json" with { type: "json" };
import { computerRecord, forgetComputer, listComputerRecords } from "./store";
import { resolveRuntime, type Runtime } from "./runtime";

/**
 * Container lifecycle for teammate computers (docs/computer.md §Lifecycle).
 *
 * Three states, one wake path: running, stopped (idle minutes — `stop`, the
 * rw layer survives), hibernated (idle days — `rm`, the workspace volume and
 * provision script survive). Wake happens on the first tool call, from
 * whichever state, and an image upgrade is deliberately the hibernate-wake
 * path with a new tag.
 */

const CONTAINER_PORT = 8787;
const VNC_PORT = 5999;

/** Idle minutes → `stop`. Frees CPU and RAM, keeps the rw layer. */
const IDLE_STOP_MS = Number(process.env.TOAD_COMPUTER_IDLE_STOP_MS) || 15 * 60_000;
/** Idle days → `rm`. Frees disk; the recipe re-grows the machine on wake. */
const HIBERNATE_MS = Number(process.env.TOAD_COMPUTER_HIBERNATE_MS) || 3 * 24 * 60 * 60_000;
const SWEEP_INTERVAL_MS = 60_000;

/** Cold boot covers Xvfb, the agent, and Chromium warmup. */
const HEALTH_TIMEOUT_MS = 60_000;
const PROVISION_TIMEOUT_MS = 5 * 60_000;

/**
 * The provision script: a teammate's recipe, kept in the workspace the same
 * way AGENTS.md is. Anything the agent cares about lives in the workspace
 * volume or this script, never only on the machine.
 */
const PROVISION_SCRIPT = "computer-provision.sh";
const WORKSPACE_MOUNT = "/home/agent/workspace";

export function containerName(personaId: string): string {
	return `toad-computer-${personaId}`;
}

/**
 * The published image, version-coupled: a fresh machine pulls its app
 * version's match from GHCR on first enable, and an app update pulls the
 * new tag instead of drifting on latest. `TOAD_COMPUTER_IMAGE` stays the
 * dev loop (`toad-computer:dev`) and the air-gap escape (`docker load`).
 */
export function defaultImage(): string {
	return process.env.TOAD_COMPUTER_IMAGE ?? `ghcr.io/1broseidon/toad-computer:${packageInfo.version}`;
}

export type ComputerEndpoint = { baseUrl: string; token: string };

type EnsureInput = {
	personaId: string;
	cwd: string;
	image?: string;
	notice?: (level: "info" | "warn" | "error", text: string) => void;
};

async function run(runtime: Runtime, args: string[], timeoutMs = 30_000): Promise<string> {
	const proc = Bun.spawn([runtime.cmd, ...args], {
		stdout: "pipe",
		stderr: "pipe",
		stdin: "ignore",
	});
	const timer = setTimeout(() => proc.kill(), timeoutMs);
	const [out, err, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	clearTimeout(timer);
	if (code !== 0) {
		throw new Error(`${runtime.cmd} ${args[0]} failed (${code}): ${err.trim() || out.trim()}`);
	}
	return out.trim();
}

type Inspection = {
	exists: boolean;
	running: boolean;
	/** The reference the container was created from, e.g. "toad-computer:0.1.0". */
	image?: string;
	/** The image ID that reference resolved to at create time. */
	imageId?: string;
};

async function inspect(runtime: Runtime, name: string): Promise<Inspection> {
	try {
		const out = await run(runtime, [
			"inspect",
			"--format",
			"{{.State.Running}} {{.Image}} {{.Config.Image}}",
			name,
		]);
		const [running, imageId, image] = out.split(" ");
		return { exists: true, running: running === "true", image, imageId };
	} catch {
		return { exists: false, running: false };
	}
}

/** Ensures the image is local and returns the ID its tag resolves to. */
async function ensureImage(runtime: Runtime, image: string, input: EnsureInput): Promise<string> {
	try {
		return await run(runtime, ["image", "inspect", "--format", "{{.Id}}", image]);
	} catch {
		// Not local; the published image is pulled on first enable, tagged to the
		// app version so an update pulls its match instead of drifting on latest.
		input.notice?.("info", `Pulling computer image ${image}…`);
		await run(runtime, ["pull", image], 10 * 60_000);
		return await run(runtime, ["image", "inspect", "--format", "{{.Id}}", image]);
	}
}

/**
 * The hardened run shape (docs/computer.md §Security). Every loosening is a
 * settings decision, not a code path: this function only knows hardened.
 */
async function create(runtime: Runtime, name: string, image: string, input: EnsureInput): Promise<void> {
	const { token } = computerRecord(input.personaId);
	await run(
		runtime,
		[
			"run",
			"-d",
			"--name",
			name,
			"--cap-drop=ALL",
			"--security-opt",
			"no-new-privileges",
			"--memory",
			"2g",
			"--pids-limit",
			"512",
			"--shm-size",
			"1g",
			// Random localhost host ports: the proxy discovers them per start, so
			// nothing collides across a roster of computers.
			"-p",
			`127.0.0.1::${CONTAINER_PORT}`,
			"-p",
			`127.0.0.1::${VNC_PORT}`,
			"-e",
			`TOAD_COMPUTER_TOKEN=${token}`,
			"-v",
			`${input.cwd}:${WORKSPACE_MOUNT}`,
			image,
		],
		120_000,
	);
}

async function hostPort(runtime: Runtime, name: string): Promise<number> {
	const out = await run(runtime, ["port", name, `${CONTAINER_PORT}/tcp`]);
	const first = out.split("\n")[0] ?? "";
	const port = Number(first.slice(first.lastIndexOf(":") + 1));
	if (!Number.isFinite(port) || port <= 0) {
		throw new Error(`Could not read the computer's published port ("${out}")`);
	}
	return port;
}

async function waitHealthy(baseUrl: string): Promise<void> {
	const deadline = Date.now() + HEALTH_TIMEOUT_MS;
	for (;;) {
		try {
			const res = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(2_000) });
			if (res.ok) return;
		} catch {}
		if (Date.now() > deadline) throw new Error("The computer did not become healthy in time.");
		await Bun.sleep(250);
	}
}

async function provision(runtime: Runtime, name: string, input: EnsureInput): Promise<void> {
	if (!existsSync(join(input.cwd, PROVISION_SCRIPT))) return;
	input.notice?.("info", "Running the computer's provision script…");
	try {
		await run(
			runtime,
			["exec", name, "sh", `${WORKSPACE_MOUNT}/${PROVISION_SCRIPT}`],
			PROVISION_TIMEOUT_MS,
		);
	} catch (error) {
		// A broken recipe costs the additions, not the computer.
		input.notice?.("warn", `Provision script failed: ${(error as Error).message}`);
	}
}

/** One wake at a time per computer; concurrent tool calls share the ensure. */
const inflight = new Map<string, Promise<ComputerEndpoint>>();

/**
 * The single wake path. Ensures the container exists (creating and
 * provisioning after hibernation or an image change), is running, and
 * answers /health — then returns where its MCP surface lives.
 */
export function ensureComputer(input: EnsureInput): Promise<ComputerEndpoint> {
	const existing = inflight.get(input.personaId);
	if (existing) return existing;

	const task = (async () => {
		const runtime = await resolveRuntime();
		const name = containerName(input.personaId);
		const image = input.image ?? defaultImage();

		const desiredId = await ensureImage(runtime, image, input);
		let state = await inspect(runtime, name);

		// An image change is the hibernate-wake path with a new tag — the same
		// code on purpose. Compared by ID as well as reference: a rebuild under
		// the same tag (every dev iteration) moves the tag to a new image while
		// the container keeps running the old one, and the reference alone
		// cannot see that. (Mount changes would recreate the same way; the cwd
		// is stable for a persona's lifetime today.)
		if (state.exists && (state.image !== image || state.imageId !== desiredId)) {
			await run(runtime, ["rm", "-f", name]);
			state = { exists: false, running: false };
		}

		const fresh = !state.exists;
		if (!state.exists) {
			await create(runtime, name, image, input);
		} else if (!state.running) {
			await run(runtime, ["start", name]);
		}

		const port = await hostPort(runtime, name);
		const baseUrl = `http://127.0.0.1:${port}`;
		await waitHealthy(baseUrl);
		if (fresh) await provision(runtime, name, input);

		return { baseUrl, token: computerRecord(input.personaId).token };
	})();

	inflight.set(
		input.personaId,
		task.finally(() => inflight.delete(input.personaId)),
	);
	return inflight.get(input.personaId)!;
}

export type ComputerState = "running" | "stopped" | "absent";

export type ComputerStatusReport = {
	state: ComputerState;
	/** The image the container was created with; the configured one when absent. */
	image: string;
	/** Which runtime owns the container, e.g. "docker". */
	runtime?: string;
	lastUsedAt?: number;
};

/**
 * What the machine looks like right now, without waking it. A peek at the
 * drawer must never be the thing that spins the container up.
 */
export async function computerStatus(personaId: string, configuredImage?: string): Promise<ComputerStatusReport> {
	const record = listComputerRecords().find((r) => r.personaId === personaId);
	const fallback = configuredImage ?? defaultImage();
	let runtime: Runtime;
	try {
		runtime = await resolveRuntime();
	} catch {
		return { state: "absent", image: fallback, lastUsedAt: record?.lastUsedAt };
	}
	const state = await inspect(runtime, containerName(personaId));
	return {
		state: state.exists ? (state.running ? "running" : "stopped") : "absent",
		image: state.image ?? fallback,
		runtime: runtime.id,
		lastUsedAt: record?.lastUsedAt,
	};
}

/**
 * Where a *running* computer answers, or null. Never wakes: the screenshot
 * path uses this so the drawer shows "asleep" instead of starting machines.
 */
export async function runningEndpoint(personaId: string): Promise<ComputerEndpoint | null> {
	let runtime: Runtime;
	try {
		runtime = await resolveRuntime();
	} catch {
		return null;
	}
	const name = containerName(personaId);
	const state = await inspect(runtime, name);
	if (!state.running) return null;
	try {
		const port = await hostPort(runtime, name);
		return { baseUrl: `http://127.0.0.1:${port}`, token: computerRecord(personaId).token };
	} catch {
		return null;
	}
}

export async function stopComputer(personaId: string): Promise<void> {
	const runtime = await resolveRuntime();
	const name = containerName(personaId);
	const state = await inspect(runtime, name);
	if (state.running) await run(runtime, ["stop", name], 60_000);
}

/** Disable/delete path: the container goes, the workspace and recipe stay. */
export async function removeComputer(personaId: string): Promise<void> {
	try {
		const runtime = await resolveRuntime();
		await run(runtime, ["rm", "-f", containerName(personaId)]);
	} catch {
		// No runtime or no container — either way there is nothing to remove.
	}
	forgetComputer(personaId);
}

/**
 * The idle sweep: stop after idle minutes, rm after idle days. Runs against
 * the store's records rather than the runtime's container list, so Toad only
 * ever manages machines it created.
 */
export async function sweepComputers(now = Date.now()): Promise<void> {
	let runtime: Runtime;
	try {
		runtime = await resolveRuntime();
	} catch {
		return;
	}
	for (const record of listComputerRecords()) {
		if (inflight.has(record.personaId)) continue;
		const idle = now - record.lastUsedAt;
		if (idle < IDLE_STOP_MS) continue;
		const name = containerName(record.personaId);
		const state = await inspect(runtime, name);
		if (!state.exists) continue;
		try {
			if (idle >= HIBERNATE_MS) {
				await run(runtime, ["rm", "-f", name]);
			} else if (state.running) {
				await run(runtime, ["stop", name], 60_000);
			}
		} catch {
			// A failed sweep retries on the next pass.
		}
	}
}

let sweeper: ReturnType<typeof setInterval> | null = null;

export function startComputerSweeper(): void {
	if (sweeper) return;
	sweeper = setInterval(() => void sweepComputers(), SWEEP_INTERVAL_MS);
}
