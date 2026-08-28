/**
 * Third-party notices for a single-binary app.
 *
 * Toad bundles its whole production dependency tree into one executable, which
 * makes every dependency's terms terms Toad distributes under. MIT and the
 * other permissive licenses all say the same thing: the copyright notice and
 * the permission notice travel with substantial portions of the software. A
 * bundle with no notices file honours none of them.
 *
 * So this walks the installed tree, collects what each package says about
 * itself, and writes one file the build copies into the app. Two rules make it
 * worth trusting:
 *
 *  - **An unexpected license fails the build.** A dependency arriving under
 *    terms nobody chose is the failure mode that matters; discovering it in a
 *    shipped binary is much worse than discovering it here. `EXPECTED` is the
 *    list, and every entry says why it is safe to bundle.
 *  - **A missing notice is reconstructed, not skipped.** Several packages —
 *    pi among them — ship no license file at all, so nothing would propagate.
 *    For MIT and ISC the notice is short and canonical, and the holder is in
 *    the package's own metadata, so it can be rebuilt exactly.
 *
 * Run: bun scripts/generate-notices.ts
 *      bun scripts/generate-notices.ts --check   (no write; exit 1 on trouble)
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { NoticePackage, ThirdPartyNotices } from "../src/shared/types";

/* Overridable so `verify:notices` can drive this at a fixture tree and prove
 * the refusal actually refuses, rather than asserting that it would. */
const root =
	process.env.TOAD_NOTICES_ROOT ?? dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const OUT = join(root, "dist", "third-party-notices.json");

/**
 * Licenses this project expects to ship, each with why bundling it is fine.
 * Anything absent from this map stops the build — that is the whole point.
 */
const EXPECTED: Record<string, string> = {
	MIT: "permissive; copyright and permission notice must travel",
	"Apache-2.0": "permissive; license and any NOTICE file must travel",
	ISC: "permissive; copyright and permission notice must travel",
	"BSD-2-Clause": "permissive; copyright notice must travel",
	"BSD-3-Clause": "permissive; copyright notice must travel",
	"0BSD": "permissive; no notice required, shipped anyway",
	"BlueOak-1.0.0": "permissive; copyright notice must travel",
	Unlicense: "public domain dedication",
	"CC0-1.0": "public domain dedication",
	"Python-2.0": "permissive; copyright notice must travel",
	/* Weak, file-level copyleft, and the only copyleft in the tree. novnc is
	 * vendored unmodified as the computer feature's VNC client: shipping it
	 * needs the notice and a route to the source, which the homepage is.
	 * Editing a novnc file would put that file under MPL — not a thing to do
	 * by accident, which is why this entry names the condition. */
	"MPL-2.0": "file-level copyleft; shipped unmodified, notice and source link travel",
};

/** Strong copyleft: a single-binary desktop app cannot honour these terms. */
const REFUSED = /^(A?GPL|LGPL|SSPL|OSL|EUPL|CDDL|EPL)/i;

const NOTICE_FILE = /^(licen[cs]e|copying|notice)(\.|$)/i;
/** Enough for any real license; a bigger file is not a notice. */
const MAX_NOTICE_BYTES = 64 * 1024;

const MIT_TERMS = `Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;

const ISC_TERMS = `Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY
AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM
LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR
OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
PERFORMANCE OF THIS SOFTWARE.`;

/**
 * Copyright lines the package metadata does not carry but the project states
 * publicly. Only for packages that ship no license file, where the alternative
 * is a notice with no holder in it.
 */
const KNOWN_COPYRIGHT: Array<[RegExp, string]> = [
	// github.com/earendil-works/pi — MIT, no LICENSE file in any npm package.
	[/^@earendil-works\//, "Copyright (c) 2025 Mario Zechner"],
];

type Manifest = {
	name?: string;
	version?: string;
	license?: unknown;
	licenses?: unknown;
	homepage?: string;
	author?: unknown;
	repository?: unknown;
	dependencies?: Record<string, string>;
	optionalDependencies?: Record<string, string>;
	patchedDependencies?: Record<string, string>;
};

function readManifest(dir: string): Manifest | null {
	try {
		return JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as Manifest;
	} catch {
		return null;
	}
}

/** Node's own resolution: nearest node_modules first, then up the tree. */
function packageDir(name: string, from: string): string | null {
	let dir = from;
	for (;;) {
		const candidate = join(dir, "node_modules", name);
		if (existsSync(join(candidate, "package.json"))) return candidate;
		const up = dirname(dir);
		if (up === dir) return null;
		dir = up;
	}
}

function licenseId(manifest: Manifest): string {
	if (typeof manifest.license === "string") return manifest.license.trim();
	// The pre-SPDX shapes, still alive in a few old packages.
	if (manifest.license && typeof manifest.license === "object") {
		const type = (manifest.license as { type?: unknown }).type;
		if (typeof type === "string") return type.trim();
	}
	if (Array.isArray(manifest.licenses)) {
		const ids = manifest.licenses
			.map((entry) => (typeof entry === "string" ? entry : (entry as { type?: string })?.type))
			.filter((id): id is string => Boolean(id));
		if (ids.length > 0) return ids.join(" OR ");
	}
	return "";
}

/**
 * Whether an SPDX expression is one we expect. `OR` needs one acceptable
 * alternative, `AND` needs all of them — the conservative reading in both
 * cases, and the resolved id is what gets recorded.
 */
function resolveLicense(expression: string): { id: string } | { refused: string } {
	const clean = expression.replace(/[()]/g, " ").replace(/\s+/g, " ").trim();
	if (!clean) return { refused: "declares no license" };
	if (clean.includes(" AND ")) {
		const parts = clean.split(" AND ").map((part) => part.trim());
		for (const part of parts) {
			const resolved = resolveLicense(part);
			if ("refused" in resolved) return resolved;
		}
		return { id: parts.join(" AND ") };
	}
	if (clean.includes(" OR ")) {
		const parts = clean.split(" OR ").map((part) => part.trim());
		for (const part of parts) {
			const resolved = resolveLicense(part);
			if ("id" in resolved) return resolved;
		}
		return { refused: `no acceptable alternative in "${expression}"` };
	}
	if (REFUSED.test(clean)) return { refused: `${clean} cannot be honoured by a single binary` };
	if (clean in EXPECTED) return { id: clean };
	return { refused: `${clean} is not in the expected set` };
}

function personName(value: unknown): string {
	if (typeof value === "string") return value.replace(/\s*<[^>]*>/g, "").replace(/\s*\([^)]*\)/g, "").trim();
	if (value && typeof value === "object") {
		const name = (value as { name?: unknown }).name;
		if (typeof name === "string") return name.trim();
	}
	return "";
}

function homepageOf(manifest: Manifest): string | undefined {
	if (typeof manifest.homepage === "string" && manifest.homepage) return manifest.homepage;
	const repository = manifest.repository;
	const url =
		typeof repository === "string"
			? repository
			: typeof (repository as { url?: unknown })?.url === "string"
				? (repository as { url: string }).url
				: "";
	if (!url) return undefined;
	const normalized = url
		.replace(/^git\+/, "")
		.replace(/^git:\/\//, "https://")
		.replace(/^ssh:\/\/git@/, "https://")
		.replace(/\.git$/, "");
	return normalized.startsWith("http") ? normalized : undefined;
}

/** Every license-ish file the package ships, in the order a reader wants them. */
function shippedNotice(dir: string): string {
	let names: string[];
	try {
		names = readdirSync(dir).filter((name) => NOTICE_FILE.test(name));
	} catch {
		return "";
	}
	const parts: string[] = [];
	for (const name of names.sort()) {
		try {
			const body = readFileSync(join(dir, name), "utf8");
			if (!body.trim() || body.length > MAX_NOTICE_BYTES) continue;
			parts.push(body.trim());
		} catch {
			// A notice we cannot read is one we have to rebuild instead.
		}
	}
	return parts.join("\n\n");
}

/**
 * The notice for a package that ships none. Only attempted for MIT and ISC,
 * whose text is canonical and whose whole substance is the copyright line —
 * anything longer would be guessed rather than reconstructed.
 */
function rebuiltNotice(name: string, license: string, manifest: Manifest): string {
	const terms = license === "MIT" ? MIT_TERMS : license === "ISC" ? ISC_TERMS : "";
	if (!terms) return "";
	const known = KNOWN_COPYRIGHT.find(([pattern]) => pattern.test(name))?.[1];
	const holder = known ?? (personName(manifest.author) ? `Copyright (c) ${personName(manifest.author)}` : "");
	if (!holder) return "";
	return `${license} License\n\n${holder}\n\n${terms}`;
}

function collect(): { notices: ThirdPartyNotices; refusals: string[]; noNotice: string[] } {
	const rootManifest = readManifest(root);
	if (!rootManifest) throw new Error("no package.json at the repository root");
	const patched = new Set(Object.keys(rootManifest.patchedDependencies ?? {}));

	const packages: NoticePackage[] = [];
	const texts: string[] = [];
	const textIndex = new Map<string, number>();
	const refusals: string[] = [];
	const noNotice: string[] = [];
	const seen = new Set<string>();

	/* Breadth-first from the declared production dependencies. devDependencies
	 * are build tooling and are not in the binary; optional dependencies are,
	 * when they installed. */
	const queue: Array<{ name: string; from: string; via: string }> = Object.keys(
		rootManifest.dependencies ?? {},
	)
		.sort()
		.map((name) => ({ name, from: root, via: "toad" }));

	while (queue.length > 0) {
		const entry = queue.shift() as { name: string; from: string; via: string };
		const dir = packageDir(entry.name, entry.from);
		if (!dir) continue;
		const manifest = readManifest(dir);
		if (!manifest?.name || !manifest.version) continue;
		const key = `${manifest.name}@${manifest.version}`;
		if (seen.has(key)) continue;
		seen.add(key);

		const declared = licenseId(manifest);
		const resolved = resolveLicense(declared);
		if ("refused" in resolved) {
			refusals.push(`${key} (via ${entry.via}) — ${resolved.refused}`);
		} else {
			const notice = shippedNotice(dir) || rebuiltNotice(manifest.name, resolved.id, manifest);
			if (!notice) noNotice.push(`${key} [${resolved.id}]`);
			const record: NoticePackage = {
				name: manifest.name,
				version: manifest.version,
				license: resolved.id,
			};
			const homepage = homepageOf(manifest);
			if (homepage) record.homepage = homepage;
			if (patched.has(key)) record.modified = true;
			if (notice) {
				let index = textIndex.get(notice);
				if (index === undefined) {
					index = texts.length;
					texts.push(notice);
					textIndex.set(notice, index);
				}
				record.text = index;
			}
			packages.push(record);
		}

		for (const dependency of Object.keys(manifest.dependencies ?? {}).sort()) {
			queue.push({ name: dependency, from: dir, via: key });
		}
		for (const dependency of Object.keys(manifest.optionalDependencies ?? {}).sort()) {
			queue.push({ name: dependency, from: dir, via: key });
		}
	}

	packages.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
	return {
		notices: {
			schemaVersion: 1,
			product: `Toad ${rootManifest.version ?? ""}`.trim(),
			packages,
			texts,
		},
		refusals,
		noNotice,
	};
}

const { notices, refusals, noNotice } = collect();

if (refusals.length > 0) {
	console.error("\x1b[31mUnexpected licenses in the production tree:\x1b[0m");
	for (const refusal of refusals) console.error(`  ${refusal}`);
	console.error(
		"\nToad ships as one binary, so these terms would be Toad's terms. Remove the\n" +
			"dependency, or add the license to EXPECTED in scripts/generate-notices.ts\n" +
			"with a line saying why bundling it is allowed.",
	);
	process.exit(1);
}

if (process.argv.includes("--check")) {
	console.log(`${notices.packages.length} packages, ${notices.texts.length} distinct notices`);
	if (noNotice.length > 0) console.log(`no notice text for: ${noNotice.join(", ")}`);
	process.exit(0);
}

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, `${JSON.stringify(notices)}\n`);
const modified = notices.packages.filter((entry) => entry.modified).map((entry) => entry.name);
console.log(
	`third-party notices: ${notices.packages.length} packages, ${notices.texts.length} distinct notices` +
		`${modified.length > 0 ? `, patched: ${modified.join(", ")}` : ""}`,
);
if (noNotice.length > 0) {
	/* Not fatal: an SPDX id and a homepage still identify the terms, and a
	 * package with neither a notice file nor an author to name is a gap in the
	 * package, not in this build. Visible so it stays small. */
	console.log(`  license id only (no notice text): ${noNotice.join(", ")}`);
}
