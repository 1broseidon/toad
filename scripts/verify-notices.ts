/**
 * The notices generator, and the wiring that gets its output into the bundle.
 *
 * Two things have to hold. The generator must refuse a licence the project did
 * not choose — asserted against a fixture tree, because a check that has never
 * fired is a check nobody should trust. And the build must actually run it and
 * actually copy the result, which is checked by reading the configs, since
 * `hutch` cannot be run from here.
 *
 * Run: bun scripts/verify-notices.ts
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ThirdPartyNotices } from "../src/shared/types";

const root = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const generator = join(root, "scripts", "generate-notices.ts");

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, detail?: unknown) => {
	console.log(
		ok ? `\x1b[32m  PASS\x1b[0m ${label}` : `\x1b[31m  FAIL\x1b[0m ${label}`,
		detail === undefined ? "" : detail,
	);
	ok ? pass++ : fail++;
};

function run(env: Record<string, string> = {}, args: string[] = []) {
	const result = Bun.spawnSync(["bun", generator, ...args], {
		cwd: root,
		env: { ...process.env, ...env },
		stdout: "pipe",
		stderr: "pipe",
	});
	return {
		code: result.exitCode,
		out: `${result.stdout.toString()}${result.stderr.toString()}`,
	};
}

/** A minimal installed tree: one root package with one dependency. */
function fixture(license: unknown): string {
	const dir = mkdtempSync(join(tmpdir(), "toad-notices-"));
	writeFileSync(
		join(dir, "package.json"),
		JSON.stringify({ name: "fixture", version: "0.0.0", dependencies: { widget: "1.0.0" } }),
	);
	const widget = join(dir, "node_modules", "widget");
	mkdirSync(widget, { recursive: true });
	const manifest: Record<string, unknown> = { name: "widget", version: "1.0.0", author: "A Person" };
	if (license !== undefined) manifest.license = license;
	writeFileSync(join(widget, "package.json"), JSON.stringify(manifest));
	return dir;
}

console.log("\x1b[36mLicence policy\x1b[0m");
for (const [label, license] of [
	["GPL-3.0-or-later", "GPL-3.0-or-later"],
	["AGPL-3.0", "AGPL-3.0"],
	["LGPL-2.1", "LGPL-2.1"],
	["an unheard-of identifier", "WTFPL-9000"],
	["no licence field at all", undefined],
] as Array<[string, unknown]>) {
	const dir = fixture(license);
	const result = run({ TOAD_NOTICES_ROOT: dir });
	check(
		`refuses ${label}`,
		result.code === 1 && result.out.includes("widget@1.0.0"),
		result.code === 1 ? undefined : result.out.slice(0, 300),
	);
	rmSync(dir, { recursive: true, force: true });
}

for (const license of ["MIT", "Apache-2.0", "MPL-2.0", "(MIT OR Apache-2.0)"]) {
	const dir = fixture(license);
	const result = run({ TOAD_NOTICES_ROOT: dir });
	check(`accepts ${license}`, result.code === 0, result.code === 0 ? undefined : result.out.slice(0, 300));
	rmSync(dir, { recursive: true, force: true });
}

{
	// "MIT AND GPL-3.0" needs both, and one of them cannot ship.
	const dir = fixture("MIT AND GPL-3.0");
	const result = run({ TOAD_NOTICES_ROOT: dir });
	check("refuses a conjunction containing copyleft", result.code === 1);
	rmSync(dir, { recursive: true, force: true });
}

console.log("\n\x1b[36mThis tree\x1b[0m");
const real = run({}, ["--check"]);
check("the production tree generates clean", real.code === 0, real.code === 0 ? undefined : real.out.slice(-600));

const written = run();
check("writing succeeds", written.code === 0, written.code === 0 ? undefined : written.out.slice(-600));

let notices: ThirdPartyNotices | undefined;
try {
	notices = JSON.parse(
		readFileSync(join(root, "dist", "third-party-notices.json"), "utf8"),
	) as ThirdPartyNotices;
} catch {
	// Left undefined; the checks below report it.
}
check("dist/third-party-notices.json parses", Boolean(notices));

if (notices) {
	const pi = notices.packages.filter((entry) => entry.name.startsWith("@earendil-works/"));
	check("pi packages are listed", pi.length >= 2, pi.length);
	/* The case that started this: pi is MIT and ships no LICENSE file, so
	 * nothing propagated until the notice was rebuilt from its metadata. */
	const piText = pi[0]?.text != null ? notices.texts[pi[0].text] : "";
	check("pi carries a copyright line", piText.includes("Mario Zechner"));
	check("pi carries the permission notice", piText.includes("Permission is hereby granted"));
	const patched = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
		patchedDependencies?: Record<string, string>;
	};
	for (const key of Object.keys(patched.patchedDependencies ?? {})) {
		const [name, version] = [key.slice(0, key.lastIndexOf("@")), key.slice(key.lastIndexOf("@") + 1)];
		const entry = notices.packages.find((row) => row.name === name && row.version === version);
		check(`${key} is marked modified`, entry?.modified === true);
	}
	check(
		"every listed package has a licence",
		notices.packages.every((entry) => Boolean(entry.license)),
	);
}

console.log("\n\x1b[36mBuild wiring\x1b[0m");
const electrobun = readFileSync(join(root, "electrobun.config.ts"), "utf8");
check(
	"electrobun copies the notices into the bundle",
	electrobun.includes('"dist/third-party-notices.json": "notices/third-party.json"'),
);

const hutch = readFileSync(join(root, "hutch.config.ts"), "utf8");
const buildLine = hutch.split("\n").find((line) => line.includes("hutch electrobun build --env=stable")) ?? "";
check("the release build runs the generator", buildLine.includes("hutch run notices"));
/* vite's emptyOutDir wipes dist/, so a generator that ran before it would have
 * its output deleted before electrobun ever copied it. */
check(
	"it runs after vite build and before the bundle",
	buildLine.indexOf("vite build") < buildLine.indexOf("hutch run notices") &&
		buildLine.indexOf("hutch run notices") < buildLine.indexOf("hutch electrobun build"),
);

console.log(
	fail === 0
		? `\n\x1b[32m${pass} passed, 0 failed\x1b[0m`
		: `\n\x1b[31m${pass} passed, ${fail} failed\x1b[0m`,
);
process.exit(fail === 0 ? 0 : 1);
