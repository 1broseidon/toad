import { platform } from "node:os";
import type { ComputerRuntimeInfo } from "../../shared/types";

/**
 * Container runtime detection (docs/computer.md §Runtimes).
 *
 * Toad shells out to the runtime CLI — docker and podman agree on the
 * `run`/`stop`/`rm`/`inspect` subset we need — and takes no SDK dependency.
 * Detection follows the backend-registry pattern: every candidate reports
 * `available` or an `unavailableReason`, and rootless runtimes rank first.
 */

export type Runtime = { id: ComputerRuntimeInfo["id"]; cmd: string; rootless: boolean };

/** A probe that hangs (a wedged daemon) should cost seconds, not a session. */
const PROBE_TIMEOUT_MS = 5_000;

async function probe(cmd: string, args: string[]): Promise<string | null> {
	try {
		const proc = Bun.spawn([cmd, ...args], {
			stdout: "pipe",
			stderr: "ignore",
			stdin: "ignore",
		});
		const timer = setTimeout(() => proc.kill(), PROBE_TIMEOUT_MS);
		const out = await new Response(proc.stdout).text();
		const code = await proc.exited;
		clearTimeout(timer);
		return code === 0 ? out.trim() : null;
	} catch {
		return null;
	}
}

async function detectDocker(): Promise<ComputerRuntimeInfo> {
	const base: Pick<ComputerRuntimeInfo, "id" | "name"> = { id: "docker", name: "Docker" };
	if (!Bun.which("docker")) {
		return { ...base, available: false, unavailableReason: "docker not found on PATH" };
	}
	const security = await probe("docker", ["info", "--format", "{{json .SecurityOptions}}"]);
	if (security === null) {
		return { ...base, available: false, unavailableReason: "docker daemon not responding" };
	}
	return { ...base, available: true, rootless: security.includes("rootless") };
}

async function detectPodman(): Promise<ComputerRuntimeInfo> {
	const base: Pick<ComputerRuntimeInfo, "id" | "name"> = { id: "podman", name: "Podman" };
	if (!Bun.which("podman")) {
		return { ...base, available: false, unavailableReason: "podman not found on PATH" };
	}
	const rootless = await probe("podman", ["info", "--format", "{{.Host.Security.Rootless}}"]);
	if (rootless === null) {
		return { ...base, available: false, unavailableReason: "podman not responding" };
	}
	return { ...base, available: true, rootless: rootless === "true" };
}

async function detectAppleContainer(): Promise<ComputerRuntimeInfo> {
	const base: Pick<ComputerRuntimeInfo, "id" | "name"> = { id: "container", name: "Apple container" };
	if (platform() !== "darwin") {
		return { ...base, available: false, unavailableReason: "macOS only" };
	}
	if (!Bun.which("container")) {
		return { ...base, available: false, unavailableReason: "container not found on PATH" };
	}
	const version = await probe("container", ["--version"]);
	if (version === null) {
		return { ...base, available: false, unavailableReason: "container not responding" };
	}
	// Apple's container runs each container in its own lightweight VM; there is
	// no root daemon on the host to be rootless relative to.
	return { ...base, available: true, rootless: true };
}

let cached: Promise<ComputerRuntimeInfo[]> | null = null;

/**
 * Every runtime Toad knows how to drive, rootless-available first, then
 * available, then the absentees with their reasons. Cached per process — a
 * daemon that comes up later is picked up via `refresh` from the settings
 * screen, not by re-probing on every wake.
 */
export function detectRuntimes(refresh = false): Promise<ComputerRuntimeInfo[]> {
	if (!cached || refresh) {
		cached = Promise.all([detectDocker(), detectPodman(), detectAppleContainer()]).then((all) =>
			all.sort((a, b) => {
				if (a.available !== b.available) return a.available ? -1 : 1;
				if (Boolean(a.rootless) !== Boolean(b.rootless)) return a.rootless ? -1 : 1;
				return 0;
			}),
		);
	}
	return cached;
}

/** The runtime a wake actually uses: the best available one. */
export async function resolveRuntime(): Promise<Runtime> {
	const runtimes = await detectRuntimes();
	const best = runtimes.find((r) => r.available);
	if (!best) {
		const reasons = runtimes.map((r) => `${r.name}: ${r.unavailableReason}`).join("; ");
		throw new Error(`No container runtime available (${reasons}).`);
	}
	return { id: best.id, cmd: best.id, rootless: best.rootless ?? false };
}
