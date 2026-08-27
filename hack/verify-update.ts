/**
 * The self-update policy, the bake-in URL, and the artifact names Electrobun
 * already emits. This does not apply an update to a running install — that
 * needs two packaged hashes and a managed channel root. Serve artifacts with
 * `--serve` and build with `TOAD_UPDATE_BASE_URL` pointing at that server.
 *
 * Run: bun hack/verify-update.ts
 *      bun hack/verify-update.ts --serve
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DESKTOP_IDENTIFIER, RELEASE_BASE_URL } from "../src/shared/release";

const root = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, detail?: unknown) => {
	console.log(
		ok ? `\x1b[32m  PASS\x1b[0m ${label}` : `\x1b[31m  FAIL\x1b[0m ${label}`,
		detail === undefined ? "" : detail,
	);
	ok ? pass++ : fail++;
};

if (process.argv.includes("--serve")) {
	const artifacts = join(root, "artifacts");
	if (!existsSync(artifacts)) {
		console.error("No artifacts/ directory. Run `hutch run build` first.");
		process.exit(1);
	}
	const port = Number(process.env.TOAD_UPDATE_SERVE_PORT ?? 8765);
	const server = Bun.serve({
		port,
		async fetch(request) {
			const name = decodeURIComponent(new URL(request.url).pathname.replace(/^\//, ""));
			if (!name || name.includes("..") || name.includes("/")) {
				return new Response("not found", { status: 404 });
			}
			const file = Bun.file(join(artifacts, name));
			if (!(await file.exists())) return new Response("not found", { status: 404 });
			return new Response(file);
		},
	});
	const base = `http://127.0.0.1:${server.port}`;
	console.log(`Serving ${artifacts}`);
	console.log(`TOAD_UPDATE_BASE_URL=${base} hutch run build`);
	console.log(`Then install that build and check for updates against ${base}`);
	await new Promise(() => {});
}

console.log("\x1b[36mPolicy\x1b[0m");
const tested = Bun.spawnSync(["bun", "test", "src/bun/update.test.ts"], {
	cwd: root,
	stdout: "pipe",
	stderr: "pipe",
});
const testOut = `${tested.stdout.toString()}${tested.stderr.toString()}`;
check("update policy tests", tested.exitCode === 0, tested.exitCode === 0 ? undefined : testOut.slice(-800));

console.log("\n\x1b[36mBaked URL\x1b[0m");
check("release host is toad.team/releases", RELEASE_BASE_URL === "https://toad.team/releases");
check("desktop identifier is team.toad.desktop", DESKTOP_IDENTIFIER === "team.toad.desktop");

const config = readFileSync(join(root, "electrobun.config.ts"), "utf8");
check("electrobun config reads package.json for version", config.includes("package.json"));
check("electrobun config uses TOAD_UPDATE_BASE_URL", config.includes("TOAD_UPDATE_BASE_URL"));
check("electrobun config imports RELEASE_BASE_URL", config.includes("RELEASE_BASE_URL"));
check("electrobun config uses DESKTOP_IDENTIFIER", config.includes("DESKTOP_IDENTIFIER"));
check("delta patches stay off", config.includes("generatePatch: false"));

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string };
check("package.json has a version", Boolean(pkg.version));

const artifacts = join(root, "artifacts");
const manifestPath = join(artifacts, "stable-linux-x64-update.json");
if (existsSync(manifestPath)) {
	console.log("\n\x1b[36mExisting artifacts\x1b[0m");
	const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
		schemaVersion?: number;
		identifier?: string;
		channel?: string;
		version?: string;
		hash?: string;
		platform?: string;
		arch?: string;
		artifact?: { file?: string };
	};
	check("manifest schemaVersion is 1", manifest.schemaVersion === 1);
	check(`manifest identifier is ${DESKTOP_IDENTIFIER}`, manifest.identifier === DESKTOP_IDENTIFIER);
	check("manifest channel is stable", manifest.channel === "stable");
	check("manifest names a .tar.zst", Boolean(manifest.artifact?.file?.endsWith(".tar.zst")));
	const file = manifest.artifact?.file;
	if (file) {
		check(
			"artifact filename matches stable-linux-x64- prefix",
			file.startsWith("stable-linux-x64-"),
		);
		const bundle = join(artifacts, file);
		check("named bundle is on disk", existsSync(bundle));
		if (existsSync(bundle)) {
			check("bundle is not empty", statSync(bundle).size > 1024);
		}
	}
} else {
	console.log("\n\x1b[36mExisting artifacts\x1b[0m");
	check("no artifacts yet (skip — run `hutch run build` to produce them)", true);
}

console.log("\n\x1b[36mLive host\x1b[0m");
const live = Bun.spawnSync(
	[
		"curl",
		"-sSI",
		"--doh-url",
		"https://1.1.1.1/dns-query",
		"--max-time",
		"20",
		`${RELEASE_BASE_URL}/stable-linux-x64-update.json`,
	],
	{ stdout: "pipe", stderr: "pipe" },
);
const headers = live.stdout.toString();
check(
	"toad.team/releases 302s at GitHub latest/download",
	live.exitCode === 0 &&
		headers.includes("HTTP/2 302") &&
		headers.includes("github.com/1broseidon/toad/releases/latest/download/stable-linux-x64-update.json"),
	live.exitCode === 0 ? undefined : live.stderr.toString().slice(0, 300),
);

console.log(
	fail === 0
		? `\n\x1b[32m${pass} passed, 0 failed\x1b[0m`
		: `\n\x1b[31m${pass} passed, ${fail} failed\x1b[0m`,
);
process.exit(fail === 0 ? 0 : 1);
