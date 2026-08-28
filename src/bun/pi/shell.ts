import { getShellConfig } from "@earendil-works/pi-coding-agent";

/**
 * Which shell tools a Toad Agent teammate gets, per platform.
 *
 * pi's shell tool is bash, and a stock Windows has no bash: no Git for
 * Windows, no Cygwin, nothing named `bash.exe` on PATH. A teammate there
 * cannot run one command — not a build, not a test, not `git status` — which
 * makes Toad Agent on Windows an agent that can only read and write files.
 *
 * pi 0.84 ships a native `powershell` tool for exactly this. Toad grants it as
 * a complement, not a substitute: on Windows PowerShell is always on, because
 * it is the one shell that machine is guaranteed to have, and bash is granted
 * *as well* whenever a real one is present. A Windows desk with Git for
 * Windows installed has the shell every README on the internet is written
 * for, and swapping that out for PowerShell to look tidy would cost the
 * teammate every command it already knows how to write. With both attached
 * the model chooses per command, which is the only party that knows whether
 * the next line is `rm -rf` or `Get-ChildItem`.
 */

/**
 * pi's own default built-in selection. Restated here only so Windows can be
 * handed a different one; every other platform is left to pi (and to the
 * user's `defaultTools` setting, which an explicit list would override).
 */
const PI_DEFAULT_TOOLS = ["read", "bash", "edit", "write"];

/**
 * Whether this machine has a bash pi could actually run.
 *
 * pi's own resolver, asked rather than made to answer: it throws on Windows
 * when it finds no Git Bash and nothing named `bash.exe` on PATH, and never
 * throws elsewhere — a Unix box always has at least `sh` behind this door.
 * Asked once per process, because the answer involves spawning `where` and a
 * shell does not appear halfway through a session.
 */
let present: boolean | undefined;
export function hasBash(): boolean {
	if (present === undefined) {
		try {
			getShellConfig();
			present = true;
		} catch {
			present = false;
		}
	}
	return present;
}

/** The same tool list, with the shell axis answered for this platform. */
export function withPlatformShells(tools: readonly string[]): string[] {
	if (process.platform !== "win32") return [...tools];
	return tools.flatMap((name) =>
		name === "bash" ? (hasBash() ? ["powershell", "bash"] : ["powershell"]) : [name],
	);
}

/**
 * The built-in tools a teammate's session starts with, or `undefined` to leave
 * pi's default — and the user's `defaultTools` — exactly as they were.
 */
export function builtInTools(): string[] | undefined {
	if (process.platform !== "win32") return undefined;
	return withPlatformShells(PI_DEFAULT_TOOLS);
}

/**
 * What to tell the user when Windows turned out to have no bash.
 *
 * The failure this replaces was pi's: the first command would come back with a
 * paragraph about Cygwin and `shellPath` that the model, not the user, was
 * reading. Said once at startup instead, to the person who can act on it, and
 * naming the one command that fixes it.
 */
export const NO_BASH_NOTICE =
	"No bash on this machine, so this teammate runs commands through PowerShell. " +
	"For bash as well — and the git most repositories expect — install Git for " +
	"Windows: winget install Git.Git";

/** Whether that notice is worth showing at all. */
export function missingBashOnWindows(): boolean {
	return process.platform === "win32" && !hasBash();
}
