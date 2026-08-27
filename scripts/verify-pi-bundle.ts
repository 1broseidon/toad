/**
 * Proves the built-in agent still works after bundling.
 *
 * Toad ships as a single bundled file, and pi has two things in it that a
 * bundler cannot see through: undici, whose npm build dies on load under Bun,
 * and the OAuth flows, which are loaded through a computed import specifier on
 * purpose so that Node-only login code stays out of browser builds. Both failed
 * only in the packaged app, and the OAuth one failed *quietly* — the model call
 * came back as a stopReason on an assistant message, so the app looked fine and
 * simply never answered.
 *
 * Running the same probe twice, from source and from a bundle built the way
 * electrobun builds the real one, is the only thing that catches that.
 *
 * Run: bun scripts/verify-pi-bundle.ts
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const probe = decodeURIComponent(new URL("./probe-pi-turn.ts", import.meta.url).pathname);
const workDir = mkdtempSync(join(tmpdir(), "toad-pi-bundle-"));

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
		check("probe exited cleanly", false, stderr.split("\n").slice(0, 6).join("\n"));
		return;
	}

	check("session reached ready", values.state === "ready", values.state ?? stderr.slice(0, 200));
	check("models were available", Number(values.models ?? 0) > 0, `${values.models} model(s)`);

	const kinds = (values.kinds ?? "").split(",");
	check("the agent answered", kinds.includes("agent"), values.kinds);
	check("a tool ran", kinds.includes("tool"), values.kinds);
	check("the file was written", values.wrote === "true");
	check("the turn was closed out", kinds.includes("turn"));
	// A failed turn must be visible. Silence is the bug this file exists for.
	check("nothing failed quietly", (values.notices ?? "").length === 0, values.notices);
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
