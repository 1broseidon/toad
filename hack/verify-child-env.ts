/**
 * The packaged app's env is not safe to hand to Node. This is the filter.
 *
 * Run: bun hack/verify-child-env.ts
 */
import { childEnv } from "../src/bun/child-env";

const saved = { ...process.env };
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
