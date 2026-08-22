import { createServer } from "node:net";
import type { Runtime } from "./runtime";

export type CommandResult = { stdout: string; stderr: string; code: number };
export type CommandExecutor = (args: string[], timeoutMs?: number) => Promise<CommandResult>;

export class RuntimeCommandError extends Error {
	constructor(
		readonly command: string,
		readonly args: string[],
		readonly result: CommandResult,
	) {
		super(`${command} ${args[0]} failed (${result.code}): ${result.stderr.trim() || result.stdout.trim()}`);
	}
}

export function createExecutor(runtime: Runtime): CommandExecutor {
	return async (args, timeoutMs = 30_000) => {
		const proc = Bun.spawn([runtime.cmd, ...args], {
			stdout: "pipe",
			stderr: "pipe",
			stdin: "ignore",
		});
		const timer = setTimeout(() => proc.kill(), timeoutMs);
		try {
			const [stdout, stderr, code] = await Promise.all([
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
				proc.exited,
			]);
			const result = { stdout: stdout.trim(), stderr: stderr.trim(), code };
			if (code !== 0) throw new RuntimeCommandError(runtime.cmd, args, result);
			return result;
		} finally {
			clearTimeout(timer);
		}
	};
}

export type Inspection = {
	exists: boolean;
	running: boolean;
	image?: string;
	/** Docker image ID or OCI descriptor digest used to create the container. */
	imageId?: string;
	ports: Record<number, number>;
};

function absent(): Inspection {
	return { exists: false, running: false, ports: {} };
}

export function isNotFound(error: unknown): boolean {
	if (!(error instanceof RuntimeCommandError)) return false;
	const message = `${error.result.stderr}\n${error.result.stdout}`.toLowerCase();
	return /(?:no such (?:object|container|image)|(?:container|image) not found|no container with)/.test(message);
}

function isPortConflict(error: unknown): boolean {
	if (!(error instanceof RuntimeCommandError)) return false;
	const message = `${error.result.stderr}\n${error.result.stdout}`.toLowerCase();
	return /address already in use|port (?:is )?already (?:allocated|in use)|failed to bind/.test(message);
}

interface AppleImageInspect {
	configuration?: { descriptor?: { digest?: string }; name?: string };
	id?: string;
}

interface AppleContainerInspect {
	configuration?: {
		image?: { descriptor?: { digest?: string }; reference?: string };
		publishedPorts?: Array<{ containerPort?: number; hostPort?: number; proto?: string }>;
	};
	status?: { state?: string };
}

function sha256(value: string): string {
	return value.startsWith("sha256:") ? value : `sha256:${value}`;
}

export function parseAppleImageInspect(json: string): { id: string; reference?: string } {
	const image = (JSON.parse(json) as AppleImageInspect[])[0];
	const id = image?.configuration?.descriptor?.digest ?? image?.id;
	if (!id) throw new Error("Apple container image inspect returned no digest");
	return { id: sha256(id), reference: image.configuration?.name };
}

export function parseAppleContainerInspect(json: string): Inspection {
	const item = (JSON.parse(json) as AppleContainerInspect[])[0];
	if (!item) throw new Error("Apple container inspect returned no container");
	const ports: Record<number, number> = {};
	for (const port of item.configuration?.publishedPorts ?? []) {
		if (port.containerPort && port.hostPort && (!port.proto || port.proto === "tcp")) {
			ports[port.containerPort] = port.hostPort;
		}
	}
	return {
		exists: true,
		running: item.status?.state === "running",
		image: item.configuration?.image?.reference,
		imageId: item.configuration?.image?.descriptor?.digest,
		ports,
	};
}

/** Compare Docker IDs and OCI digests without depending on formatting or case. */
export function sameImageId(left?: string, right?: string): boolean {
	if (!left || !right) return false;
	const digest = (value: string) => value.match(/(?:sha256:)?([a-f\d]{64})/i)?.[1]?.toLowerCase();
	const leftDigest = digest(left);
	const rightDigest = digest(right);
	return leftDigest !== undefined && leftDigest === rightDigest;
}

/**
 * Whether a live container is on a different image than the one we want.
 * Prefer digest equality — Apple's reference string is a fully-qualified
 * name (`docker.io/…`) even when we asked for `ghcr.io/…:tag`.
 */
export function imageChanged(state: Inspection, image: string, desiredId: string): boolean {
	if (!state.exists) return false;
	if (sameImageId(state.imageId, desiredId)) return false;
	if (state.imageId && desiredId) return true;
	return Boolean(state.image && state.image !== image);
}

/** Ask the kernel for a currently free loopback port. Apple requires an explicit host port. */
export function freeLoopbackPort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (!address || typeof address === "string") {
				server.close();
				reject(new Error("Could not allocate a loopback port"));
				return;
			}
			server.close((error) => (error ? reject(error) : resolve(address.port)));
		});
	});
}

export type CreateOptions = {
	name: string;
	image: string;
	personaId: string;
	token: string;
	cwd: string;
	/** Container ports to publish on 127.0.0.1 (MCP, VNC, …). */
	ports: number[];
};

export class ContainerDriver {
	readonly execute: CommandExecutor;

	constructor(
		readonly runtime: Runtime,
		execute: CommandExecutor = createExecutor(runtime),
	) {
		this.execute = execute;
	}

	async command(args: string[], timeoutMs?: number): Promise<string> {
		return (await this.execute(args, timeoutMs)).stdout;
	}

	async inspect(name: string): Promise<Inspection> {
		try {
			if (this.runtime.id === "container") {
				return parseAppleContainerInspect(await this.command(["inspect", name]));
			}
			const out = await this.command([
				"inspect",
				"--format",
				"{{.State.Running}} {{.Image}} {{.Config.Image}}",
				name,
			]);
			const [running, imageId, image] = out.split(" ");
			return { exists: true, running: running === "true", image, imageId, ports: {} };
		} catch (error) {
			if (isNotFound(error)) return absent();
			throw error;
		}
	}

	async ensureImage(image: string, onPull: () => void): Promise<string> {
		try {
			return await this.imageId(image);
		} catch (error) {
			if (!isNotFound(error)) throw error;
			onPull();
			await this.command(this.runtime.id === "container" ? ["image", "pull", image] : ["pull", image], 10 * 60_000);
			return await this.imageId(image);
		}
	}

	private async imageId(image: string): Promise<string> {
		if (this.runtime.id === "container") {
			return parseAppleImageInspect(await this.command(["image", "inspect", image])).id;
		}
		return await this.command(["image", "inspect", "--format", "{{.Id}}", image]);
	}

	async runArgs(options: CreateOptions): Promise<string[]> {
		const args = [
			"run",
			"-d",
			"--name",
			options.name,
			"--label",
			"dev.toad.computer=true",
			"--label",
			`dev.toad.persona=${options.personaId}`,
			"--cap-drop=ALL",
		];
		// Apple container does not implement these Docker/Podman hardening flags.
		if (this.runtime.id !== "container") {
			args.push("--security-opt", "no-new-privileges", "--pids-limit", "512");
		}
		args.push("--memory", "2g", "--shm-size", "1g");
		for (const containerPort of options.ports) {
			const hostPort = this.runtime.id === "container" ? await freeLoopbackPort() : "";
			args.push("-p", `127.0.0.1:${hostPort}:${containerPort}`);
		}
		args.push("-e", `TOAD_COMPUTER_TOKEN=${options.token}`, "-v", `${options.cwd}:/home/agent/workspace`, options.image);
		return args;
	}

	async create(options: CreateOptions): Promise<void> {
		const attempts = this.runtime.id === "container" ? 3 : 1;
		for (let attempt = 1; attempt <= attempts; attempt++) {
			try {
				await this.command(await this.runArgs(options), 120_000);
				return;
			} catch (error) {
				if (attempt === attempts || !isPortConflict(error)) throw error;
				// Apple's failed bootstrap may leave the name reserved. Remove only
				// after the failure was positively identified as a bind race.
				try {
					await this.command(["rm", "-f", options.name]);
				} catch (removeError) {
					if (!isNotFound(removeError)) throw removeError;
				}
			}
		}
	}

	async hostPort(name: string, containerPort: number, inspection?: Inspection): Promise<number> {
		if (this.runtime.id === "container") {
			const port = (inspection ?? (await this.inspect(name))).ports[containerPort];
			if (port) return port;
			throw new Error(`Could not read the computer's published port for ${containerPort}/tcp`);
		}
		const out = await this.command(["port", name, `${containerPort}/tcp`]);
		const first = out.split("\n")[0] ?? "";
		const port = Number(first.slice(first.lastIndexOf(":") + 1));
		if (!Number.isFinite(port) || port <= 0) throw new Error(`Could not read the computer's published port ("${out}")`);
		return port;
	}
}
