/**
 * Unit proof of the runtime dialect layer: Apple JSON inspect, digest
 * comparison, not-found matching, and the run-arg shape each runtime gets.
 * No daemon, no image.
 *
 * Run: bun hack/verify-computer-driver.ts
 */
import {
	ContainerDriver,
	RuntimeCommandError,
	imageChanged,
	isNotFound,
	parseAppleContainerInspect,
	parseAppleImageInspect,
	sameImageId,
	type CommandResult,
	type Inspection,
} from "../src/bun/computer/driver";
import type { Runtime } from "../src/bun/computer/runtime";

let passed = 0;
let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
	if (ok) passed++;
	else failed++;
	console.log(`  ${ok ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m"} ${name}${detail ? ` ${detail}` : ""}`);
};

const appleImage = JSON.stringify([
	{
		configuration: {
			descriptor: { digest: "sha256:28bd5fe8b56d1bd048e5babf5b10710ebe0bae67db86916198a6eec434943f8b" },
			name: "docker.io/library/alpine:latest",
		},
		id: "28bd5fe8b56d1bd048e5babf5b10710ebe0bae67db86916198a6eec434943f8b",
	},
]);

const appleContainer = JSON.stringify([
	{
		configuration: {
			image: {
				descriptor: { digest: "sha256:28bd5fe8b56d1bd048e5babf5b10710ebe0bae67db86916198a6eec434943f8b" },
				reference: "docker.io/library/alpine:latest",
			},
			publishedPorts: [
				{ containerPort: 8787, hostPort: 18787, proto: "tcp", hostAddress: "127.0.0.1" },
				{ containerPort: 5999, hostPort: 15999, proto: "tcp", hostAddress: "127.0.0.1" },
			],
		},
		status: { state: "running" },
	},
]);

console.log("\x1b[36mApple inspect\x1b[0m");
const image = parseAppleImageInspect(appleImage);
check("image digest is sha256-prefixed", image.id === "sha256:28bd5fe8b56d1bd048e5babf5b10710ebe0bae67db86916198a6eec434943f8b");
check("image reference kept", image.reference === "docker.io/library/alpine:latest");

const inspection = parseAppleContainerInspect(appleContainer);
check("container running", inspection.running);
check("mcp host port", inspection.ports[8787] === 18787);
check("vnc host port", inspection.ports[5999] === 15999);
check(
	"container image id is the digest",
	inspection.imageId === "sha256:28bd5fe8b56d1bd048e5babf5b10710ebe0bae67db86916198a6eec434943f8b",
);

console.log("\n\x1b[36mIdentity\x1b[0m");
const digest = "28bd5fe8b56d1bd048e5babf5b10710ebe0bae67db86916198a6eec434943f8b";
check("same digest ignores sha256 prefix and case", sameImageId(`sha256:${digest}`, digest.toUpperCase()));
check("different digests are different", !sameImageId(`sha256:${digest}`, "sha256:" + "ab".repeat(32)));
const live: Inspection = {
	exists: true,
	running: true,
	image: "docker.io/library/alpine:latest",
	imageId: "sha256:28bd5fe8b56d1bd048e5babf5b10710ebe0bae67db86916198a6eec434943f8b",
	ports: {},
};
check(
	"same digest is not an image change even when the reference is fully qualified",
	!imageChanged(live, "alpine:latest", "sha256:28bd5fe8b56d1bd048e5babf5b10710ebe0bae67db86916198a6eec434943f8b"),
);
check(
	"different digest is an image change",
	imageChanged(live, "alpine:latest", "sha256:" + "ab".repeat(32)),
);

console.log("\n\x1b[36mNot-found\x1b[0m");
const fail = (stderr: string) =>
	new RuntimeCommandError("container", ["inspect", "x"], { stdout: "", stderr, code: 1 });
check("apple container not found", isNotFound(fail("Error: container not found: toad-computer-x")));
check("apple image not found", isNotFound(fail("Error: image not found: ghcr.io/1broseidon/toad-computer:0.1.0")));
check("docker no such object", isNotFound(fail("Error: No such object: toad-computer-x")));
check("unrelated error is not not-found", !isNotFound(fail("Error: Plugin 'container-pull' not found.")));
check("plain Error is not not-found", !isNotFound(new Error("container not found")));

console.log("\n\x1b[36mRun args\x1b[0m");
const recorded: string[][] = [];
const fakeExecute = async (args: string[]): Promise<CommandResult> => {
	recorded.push(args);
	return { stdout: "", stderr: "", code: 0 };
};
const apple: Runtime = { id: "container", cmd: "container", rootless: true };
const docker: Runtime = { id: "docker", cmd: "docker", rootless: false };
const options = {
	name: "toad-computer-x",
	image: "ghcr.io/1broseidon/toad-computer:0.1.0",
	personaId: "x",
	token: "secret",
	cwd: "/tmp/ws",
	ports: [8787, 5999],
};

const appleArgs = await new ContainerDriver(apple, fakeExecute).runArgs(options);
check("apple does not pass --security-opt", !appleArgs.includes("--security-opt"));
check("apple does not pass --pids-limit", !appleArgs.includes("--pids-limit"));
check("apple still drops caps", appleArgs.includes("--cap-drop=ALL"));
const applePublish = appleArgs.filter((_, i) => appleArgs[i - 1] === "-p");
check(
	"apple publishes explicit host ports",
	applePublish.length === 2 && applePublish.every((spec) => /^127\.0\.0\.1:\d+:(8787|5999)$/.test(spec)),
	applePublish.join(" "),
);
check("apple does not use docker-style empty host port", applePublish.every((spec) => !spec.includes("::")));

recorded.length = 0;
const dockerArgs = await new ContainerDriver(docker, fakeExecute).runArgs(options);
check("docker keeps no-new-privileges", dockerArgs.includes("no-new-privileges"));
check("docker keeps pids-limit", dockerArgs.includes("--pids-limit"));
const dockerPublish = dockerArgs.filter((_, i) => dockerArgs[i - 1] === "-p");
check(
	"docker uses kernel-assigned host ports",
	dockerPublish.length === 2 && dockerPublish.every((spec) => spec.startsWith("127.0.0.1::")),
	dockerPublish.join(" "),
);

const pullApple = new ContainerDriver(apple, async (args) => {
	recorded.push(args);
	if (args[0] === "image" && args[1] === "inspect") {
		throw new RuntimeCommandError("container", args, {
			stdout: "",
			stderr: "Error: image not found: x",
			code: 1,
		});
	}
	if (args[0] === "image" && args[1] === "pull") return { stdout: "", stderr: "", code: 0 };
	throw new Error(`unexpected ${args.join(" ")}`);
});
recorded.length = 0;
let pulled = false;
try {
	await pullApple.ensureImage("ghcr.io/1broseidon/toad-computer:0.1.0", () => {
		pulled = true;
	});
	check("apple missing image does not succeed without a digest", false);
} catch (error) {
	check("apple pull uses image pull, not pull", recorded.some((args) => args[0] === "image" && args[1] === "pull"));
	check("apple pull was attempted after not-found", pulled);
	check("second inspect after pull still surfaces", error instanceof Error);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
