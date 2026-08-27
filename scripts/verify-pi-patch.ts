/**
 * The OAuth callback page and User-Agent live inside pi-ai. Toad overlays them
 * with a bun patch. `bun install` already fails if the hunks do not apply;
 * this catches the quieter case: a version bump whose `patchedDependencies`
 * key still names the old release, so install succeeds and ships stock pi.
 *
 * Run: bun scripts/verify-pi-patch.ts
 */
import { dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const root = require("../package.json") as {
	patchedDependencies?: Record<string, string>;
};
// Bun hands this back as a file: URL on macOS and Linux but as a bare
// `C:\…` path on Windows, where fileURLToPath reads the drive as a scheme.
const piSpecifier = import.meta.resolve("@earendil-works/pi-ai/package.json");
const piManifest = piSpecifier.startsWith("file:") ? fileURLToPath(piSpecifier) : piSpecifier;
const installed = require(piManifest) as { version: string };
const piRoot = dirname(piManifest);
const key = `@earendil-works/pi-ai@${installed.version}`;

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, detail?: unknown) => {
	console.log(
		ok ? `\x1b[32m  PASS\x1b[0m ${label}` : `\x1b[31m  FAIL\x1b[0m ${label}`,
		detail === undefined ? "" : detail,
	);
	ok ? pass++ : fail++;
};

check(
	"patchedDependencies names the installed pi-ai version",
	Boolean(root.patchedDependencies?.[key]),
	`installed ${installed.version}; keys: ${Object.keys(root.patchedDependencies ?? {}).join(", ") || "(none)"}`,
);

const oauth = (await import(
	pathToFileURL(`${piRoot}/dist/auth/oauth/oauth-page.js`).href
)) as {
	oauthSuccessHtml(message: string): string;
	oauthErrorHtml(message: string, details?: string): string;
};
const { getPiUserAgent } = (await import(
	pathToFileURL(`${piRoot}/dist/utils/pi-user-agent.js`).href
)) as { getPiUserAgent(): string };

const success = oauth.oauthSuccessHtml("Anthropic authentication completed. You can close this window.");
const error = oauth.oauthErrorHtml("Anthropic authentication did not complete.");
const agent = getPiUserAgent();

check("success page is Toad-branded", success.includes("Signed in to Toad") && success.includes("toad-pupils"));
check("error page is Toad-branded", error.includes("Could not sign in to Toad") && error.includes("toad-pupils"));
check("provider message is still in the page", success.includes("Anthropic authentication completed"));
check("User-Agent is toadbot", agent.startsWith("toadbot "));

console.log(
	fail === 0
		? `\n\x1b[32m${pass} passed, 0 failed\x1b[0m`
		: `\n\x1b[31m${pass} passed, ${fail} failed\x1b[0m`,
);
process.exit(fail === 0 ? 0 : 1);
