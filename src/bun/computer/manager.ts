import { existsSync } from "node:fs";
import { join } from "node:path";
import { ContainerDriver, imageChanged, type Inspection } from "./driver";
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
 *
 * Runtime commands go through ContainerDriver so Docker/Podman and Apple
 * `container` can disagree on inspect/pull/port without this file growing
 * a dialect per verb.
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
 * The toad.computer release this desktop is built against. The computer is
 * its own product on its own schedule (its Implementation stamp lives in
 * computer/cmd/computer-agent/serve.go); this pin is a dependency, bumped
 * here deliberately when the desktop is ready for a new image — never
 * derived from the desktop version, and never `latest`. `TOAD_COMPUTER_IMAGE`
 * stays the dev loop (`toad-computer:dev`) and the air-gap escape
 * (`docker load`).
 */
const COMPUTER_VERSION = "0.2.0";

export function defaultImage(): string {
	return process.env.TOAD_COMPUTER_IMAGE ?? `ghcr.io/1broseidon/toad-computer:${COMPUTER_VERSION}`;
}

export type ComputerEndpoint = { baseUrl: string; token: string };

export type EnsureInput = {
	personaId: string;
	cwd: string;
	image?: string;
	notice?: (level: "info" | "warn" | "error", text: string) => void;
};

function driverFor(runtime: Runtime): ContainerDriver {
	return new ContainerDriver(runtime);
}

/** Peek must never throw: a wedged daemon is "absent", not a crashed drawer. */
async function peek(driver: ContainerDriver, name: string): Promise<Inspection> {
	try {
		return await driver.inspect(name);
	} catch {
		return { exists: false, running: false, ports: {} };
	}
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

async function provision(driver: ContainerDriver, name: string, input: EnsureInput): Promise<void> {
	if (!existsSync(join(input.cwd, PROVISION_SCRIPT))) return;
	input.notice?.("info", "Running the computer's provision script…");
	try {
		await driver.command(["exec", name, "sh", `${WORKSPACE_MOUNT}/${PROVISION_SCRIPT}`], PROVISION_TIMEOUT_MS);
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
		const driver = driverFor(runtime);
		const name = containerName(input.personaId);
		const image = input.image ?? defaultImage();

		const desiredId = await driver.ensureImage(image, () => {
			input.notice?.("info", `Pulling computer image ${image}…`);
		});
		let state = await driver.inspect(name);

		// An image change is the hibernate-wake path with a new tag — the same
		// code on purpose. Compared by digest as well as reference: a rebuild
		// under the same tag (every dev iteration) moves the tag to a new image
		// while the container keeps running the old one, and Apple's reference
		// string is fully-qualified even when we asked for a short name.
		if (imageChanged(state, image, desiredId)) {
			await driver.command(["rm", "-f", name]);
			state = { exists: false, running: false, ports: {} };
		}

		const fresh = !state.exists;
		if (!state.exists) {
			const { token } = computerRecord(input.personaId);
			await driver.create({
				name,
				image,
				personaId: input.personaId,
				token,
				cwd: input.cwd,
				ports: [CONTAINER_PORT, VNC_PORT],
			});
		} else if (!state.running) {
			await driver.command(["start", name]);
		}

		const port = await driver.hostPort(name, CONTAINER_PORT);
		const baseUrl = `http://127.0.0.1:${port}`;
		await waitHealthy(baseUrl);
		if (fresh) await provision(driver, name, input);

		return { baseUrl, token: computerRecord(input.personaId).token };
	})();

	inflight.set(
		input.personaId,
		task.finally(() => inflight.delete(input.personaId)),
	);
	return inflight.get(input.personaId)!;
}

/**
 * Start a wake without awaiting it. Session start uses this so a first-time
 * pull overlaps the MCP handshake instead of making the agent wait to see
 * its tools — or blocking the first tool call on the whole pull.
 */
export function warmComputer(input: EnsureInput): void {
	void ensureComputer(input).catch((error) => {
		input.notice?.("warn", `The computer could not wake: ${(error as Error).message}`);
	});
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
	const state = await peek(driverFor(runtime), containerName(personaId));
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
	const driver = driverFor(runtime);
	const name = containerName(personaId);
	const state = await peek(driver, name);
	if (!state.running) return null;
	try {
		const port = await driver.hostPort(name, CONTAINER_PORT, state);
		return { baseUrl: `http://127.0.0.1:${port}`, token: computerRecord(personaId).token };
	} catch {
		return null;
	}
}

export async function stopComputer(personaId: string): Promise<void> {
	const driver = driverFor(await resolveRuntime());
	const name = containerName(personaId);
	const state = await peek(driver, name);
	if (state.running) await driver.command(["stop", name], 60_000);
}

/** Disable/delete path: the container goes, the workspace and recipe stay. */
export async function removeComputer(personaId: string): Promise<void> {
	try {
		const driver = driverFor(await resolveRuntime());
		await driver.command(["rm", "-f", containerName(personaId)]);
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
	const driver = driverFor(runtime);
	for (const record of listComputerRecords()) {
		if (inflight.has(record.personaId)) continue;
		const idle = now - record.lastUsedAt;
		if (idle < IDLE_STOP_MS) continue;
		const name = containerName(record.personaId);
		const state = await peek(driver, name);
		if (!state.exists) continue;
		try {
			if (idle >= HIBERNATE_MS) {
				await driver.command(["rm", "-f", name]);
			} else if (state.running) {
				await driver.command(["stop", name], 60_000);
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
