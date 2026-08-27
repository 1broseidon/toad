/**
 * Proves the record store still works after bundling.
 *
 * Toad ships as a single bundled file. `bun:sqlite` and the store's lazy
 * `require` of the node identity are the kinds of thing a bundler can drop or
 * rewrite. Running the same probe twice, from source and from a bundle built
 * the way `verify-pi-bundle` builds, is what catches that.
 *
 * This proves the `bun build --target=bun` pipeline only. It does not prove
 * the Electrobun app build (`hutch run build`).
 *
 * Run: bun scripts/verify-store-bundle.ts
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const probe = decodeURIComponent(new URL("./probe-store.ts", import.meta.url).pathname);
const workDir = mkdtempSync(join(tmpdir(), "toad-store-bundle-"));

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, detail?: unknown) => {
	console.log(
		ok ? `\x1b[32m  PASS\x1b[0m ${label}` : `\x1b[31m  FAIL\x1b[0m ${label}`,
		detail === undefined ? "" : detail,
	);
	ok ? pass++ : fail++;
};

function parse(stdout: string): Record<string, string> {
	const values: Record<string, string> = {};
	for (const line of stdout.split("\n")) {
		const eq = line.indexOf("=");
		if (eq > 0) values[line.slice(0, eq)] = line.slice(eq + 1);
	}
	return values;
}

async function runProbe(label: string, command: string[]): Promise<void> {
	console.log(`\n\x1b[36m${label}\x1b[0m`);
	const result = Bun.spawnSync(command, { stdout: "pipe", stderr: "pipe" });
	const stdout = result.stdout.toString();
	const stderr = result.stderr.toString();
	const values = parse(stdout);

	if (result.exitCode !== 0) {
		check("probe exited cleanly", false, stderr.split("\n").slice(0, 6).join("\n") || stdout);
		return;
	}

	check("probe exited cleanly", true);
	check("stale epoch refused", values.stale === "refused", values.stale ?? stdout.slice(0, 200));
	check("rows survived a second sqlite connection", Number(values.rows ?? 0) === 2, values.rows);
}

await runProbe("From source", ["bun", probe]);

console.log("\n\x1b[36mBundling\x1b[0m");
const bundle = join(workDir, "probe.js");
const built = Bun.spawnSync(
	[
		"bun",
		"build",
		probe,
		"--target=bun",
		// Kept in step with build.bun.external in electrobun.config.ts.
		"--external",
		"undici",
		"--outfile",
		bundle,
	],
	{ stdout: "pipe", stderr: "pipe" },
);
check("bundle built", built.exitCode === 0, built.stderr.toString().slice(0, 300));

if (built.exitCode === 0) {
	await runProbe("From a bundle", ["bun", bundle]);
}

rmSync(workDir, { recursive: true, force: true });

console.log(
	fail === 0
		? `\n\x1b[32m${pass} passed, 0 failed\x1b[0m`
		: `\n\x1b[31m${pass} passed, ${fail} failed\x1b[0m`,
);
process.exit(fail === 0 ? 0 : 1);
