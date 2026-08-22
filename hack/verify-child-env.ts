/**
 * The packaged app's env is not safe to hand to Node. This is the filter.
 *
 * Run: bun hack/verify-child-env.ts
 */
import { delimiter } from "node:path";
import {
	childEnv,
	mergePath,
	restoreUserPath,
	wellKnownBinDirs,
	whichOnPath,
} from "../src/bun/child-env";
import { bunx } from "../src/bun/acp/registry";

const saved = { ...process.env };
const installedClaude = whichOnPath("claude");
const minimalPath = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(delimiter);
process.env.PATH = minimalPath;
// Bare Bun.which would still see the full startup PATH here; whichOnPath must
// not, or every availability check downstream is testing the wrong thing.
const hiddenOnMinimalPath = whichOnPath("claude") === null;
const restoredPath = await restoreUserPath();

process.env.NODE_CHANNEL_FD = "3";
process.env.NODE_UNIQUE_ID = "1";
process.env.ELECTRON_RUN_AS_NODE = "1";
process.env.LD_LIBRARY_PATH = `.:${process.cwd()}:/usr/lib`;
process.env.npm_node_execpath = process.execPath;

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
	"merges shell and inherited PATH without duplicates",
	mergePath(`/user/bin${delimiter}/usr/bin`, `/usr/bin${delimiter}/bin`) ===
		[`/user/bin`, `/usr/bin`, `/bin`].join(delimiter),
);
check(
	"keeps minimal GUI PATH entries",
	minimalPath.split(delimiter).every((entry) => restoredPath.split(delimiter).includes(entry)),
);
check(
	"PATH-aware which honors the live PATH, not the startup snapshot",
	!installedClaude || hiddenOnMinimalPath,
);
check(
	"recovers an installed ACP CLI from the login shell",
	!installedClaude || whichOnPath("claude") === installedClaude,
	installedClaude ?? "claude is not installed on this test host",
);
check(
	"folds well-known install dirs into PATH",
	wellKnownBinDirs().every((dir) => restoredPath.split(delimiter).includes(dir)),
);

const adapted = bunx({ cmd: "npx", args: ["-y", "@agentclientprotocol/claude-agent-acp@0.70.0"] });
check(
	"adapters fall back to Toad's own Bun when npx is missing",
	adapted.cmd === process.execPath &&
		adapted.args[0] === "x" &&
		!adapted.args.includes("-y") &&
		adapted.args.includes("@agentclientprotocol/claude-agent-acp@0.70.0"),
	adapted,
);

const env = childEnv({ CLAUDE_EXTRA: "1" });
check("drops NODE_CHANNEL_FD", env.NODE_CHANNEL_FD === undefined);
check("drops NODE_UNIQUE_ID", env.NODE_UNIQUE_ID === undefined);
check("drops ELECTRON_RUN_AS_NODE", env.ELECTRON_RUN_AS_NODE === undefined);
check("drops bun as npm_node_execpath", env.npm_node_execpath === undefined);
check("drops . from LD_LIBRARY_PATH", !env.LD_LIBRARY_PATH?.split(":").includes("."));
check("keeps real library dirs", env.LD_LIBRARY_PATH?.includes("/usr/lib") === true);
check("keeps PATH", typeof env.PATH === "string" && env.PATH.length > 0);
check("applies extras", env.CLAUDE_EXTRA === "1");

Object.assign(process.env, saved);
delete process.env.NODE_CHANNEL_FD;
delete process.env.NODE_UNIQUE_ID;
delete process.env.ELECTRON_RUN_AS_NODE;

console.log(
	fail === 0
		? `\n\x1b[32m${pass} passed, 0 failed\x1b[0m`
		: `\n\x1b[31m${pass} passed, ${fail} failed\x1b[0m`,
);
process.exit(fail === 0 ? 0 : 1);
