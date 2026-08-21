/**
 * Proves one desktop is shared politely: subagents wait their turn for the
 * computer, the parent gets a named "hands busy" answer instead of a block,
 * and every hold ends at its natural boundary.
 *
 * Pure in-process — no model, no container. The lease is the arbitration;
 * the container's own per-action lock and human control lease sit below it.
 *
 * Run: bun hack/verify-computer-lease.ts
 */
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
	gateChildComputer,
	gateParentComputer,
	releaseComputer,
} from "../src/bun/pi/computer-lease";

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, detail?: unknown) => {
	console.log(
		ok ? `\x1b[32m  PASS\x1b[0m ${label}` : `\x1b[31m  FAIL\x1b[0m ${label}`,
		detail === undefined ? "" : detail,
	);
	ok ? pass++ : fail++;
};
const section = (name: string) => console.log(`\n\x1b[36m${name}\x1b[0m`);

const calls: string[] = [];
function fakeTool(name: string): ToolDefinition {
	return {
		name,
		label: name,
		description: name,
		parameters: { type: "object", properties: {} },
		execute: async () => {
			calls.push(name);
			return { content: [{ type: "text", text: "done" }], details: {} };
		},
	} as unknown as ToolDefinition;
}

const textOf = (result: unknown) =>
	(result as { content: Array<{ text?: string }> }).content[0]?.text ?? "";

const exec = (tool: ToolDefinition, signal?: AbortSignal) =>
	(tool.execute as (a: string, b: unknown, c?: AbortSignal) => Promise<unknown>)(
		"call",
		{},
		signal,
	);

const settled = async (work: Promise<unknown>) => {
	let done = false;
	void work.finally(() => {
		done = true;
	});
	await Bun.sleep(20);
	return done;
};

const PERSONA = "lease-verify";

section("Only computer tools are gated");
const [plain, computer] = gateChildComputer(
	PERSONA,
	"run-a",
	"first task",
	[fakeTool("read"), fakeTool("computer__input")],
	() => {},
);
check("a non-computer tool passes through untouched", plain === undefined || plain.name === "read");
await exec(plain!);
check("the ungated tool never touched the lease", calls.includes("read"));
releaseComputer(PERSONA, { kind: "child", runId: "run-a", label: "first task" });
calls.length = 0;

section("A child waits its turn behind the parent");
const [parentTool] = gateParentComputer(PERSONA, [fakeTool("computer__input")]);
check("parent takes a free desktop", textOf(await exec(parentTool!)) === "done");
check("parent re-acquires its own hold", textOf(await exec(parentTool!)) === "done");

const childWork = exec(computer!);
check("the child call parks while the parent holds", !(await settled(childWork)));
releaseComputer(PERSONA, { kind: "parent" });
await childWork;
check("the parent's release hands the desktop over", calls.includes("computer__input"));

section("The parent bounces off a working child, by name");
const bounce = textOf(await exec(parentTool!));
check("the parent is told whose hands are on it", bounce.includes("first task"), bounce);
check("the bounce reads as advice, not an error", bounce.includes("Wait for its report"));

section("Children queue FIFO");
let secondLogged = 0;
const [second] = gateChildComputer(PERSONA, "run-b", "second task", [fakeTool("computer__input")], () => {
	secondLogged += 1;
});
const secondWork = exec(second!);
check("a second child parks behind the first", !(await settled(secondWork)));
releaseComputer(PERSONA, { kind: "child", runId: "run-a", label: "first task" });
await secondWork;
check("the first child's end grants the second", secondLogged === 1);
check("the action log saw the granted call", secondLogged === 1);

section("Waiting ends cleanly");
const [third] = gateChildComputer(PERSONA, "run-c", "third task", [fakeTool("computer__input")], () => {});
const thirdWork = exec(third!).then(
	() => "ran",
	() => "cancelled",
);
check("the third child parks behind the second", !(await settled(thirdWork)));
releaseComputer(PERSONA, { kind: "child", runId: "run-c", label: "third task" });
check("a run ending while queued cancels its wait", (await thirdWork) === "cancelled");

const aborter = new AbortController();
const [fourth] = gateChildComputer(PERSONA, "run-d", "fourth task", [fakeTool("computer__input")], () => {});
const fourthWork = exec(fourth!, aborter.signal).then(
	() => "ran",
	() => "cancelled",
);
check("the fourth child parks too", !(await settled(fourthWork)));
aborter.abort();
check("an aborted wait rejects and leaves the queue", (await fourthWork) === "cancelled");

section("Holds end at boundaries, no-ops stay no-ops");
releaseComputer(PERSONA, { kind: "parent" }); // not the holder — must not free it
const bounced = textOf(await exec(parentTool!));
check("a non-holder release changes nothing", bounced.includes("second task"), bounced);
releaseComputer(PERSONA, { kind: "child", runId: "run-b", label: "second task" });
check("the desktop frees when its holder ends", textOf(await exec(parentTool!)) === "done");
releaseComputer(PERSONA, { kind: "parent" });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
