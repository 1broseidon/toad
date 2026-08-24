/**
 * Focused ACP permission lifecycle verification.
 *
 * Run: bun hack/verify-acp-permissions.ts
 */
import type { Persona, TranscriptEvent } from "../src/shared/types";
import { AcpSession } from "../src/bun/acp/session";
import { expireOrphanedPermissions } from "../src/bun/acp/permissions";

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean): void {
	ok ? passed++ : failed++;
	console.log(
		`  ${ok ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m"} ${name}`,
	);
}

const persona: Persona = {
	id: "permission-test",
	name: "Test",
	goal: "",
	backendId: "test",
	cwd: "/tmp",
	mcpPolicy: { mode: "none", serverIds: [] },
	sessionCheckpoints: [],
	createdAt: 0,
	updatedAt: 0,
};

type PermissionResult = {
	outcome: { outcome: "selected"; optionId: string } | { outcome: "cancelled" };
};
type PermissionHarness = {
	handlePermission(params: Record<string, unknown>): Promise<PermissionResult>;
};

function harness(timeoutMs = 30): {
	session: AcpSession;
	call: PermissionHarness["handlePermission"];
	appended: TranscriptEvent[];
	updated: TranscriptEvent[];
} {
	const appended: TranscriptEvent[] = [];
	const updated: TranscriptEvent[] = [];
	const session = new AcpSession(
		persona,
		{
			appendEvent: (event) => appended.push(event),
			updateEvent: (event) => updated.push(event),
			delta: () => {},
			infoChanged: () => {},
			history: () => [],
			sessionCheckpointed: () => {},
		},
		{ permissionTimeoutMs: timeoutMs },
	);
	const privateSession = session as unknown as PermissionHarness;
	return {
		session,
		call: privateSession.handlePermission.bind(privateSession),
		appended,
		updated,
	};
}

const params = {
	toolCall: { title: "Run tests" },
	options: [{ optionId: "yes", name: "Allow once" }],
};

// Manual answers keep their existing selected outcome and card label.
{
	const test = harness(1_000);
	const result = test.call(params);
	const pending = test.appended[0];
	check(
		"permission appends pending card",
		pending?.kind === "permission" && pending.decision === undefined,
	);
	const requestId = pending?.kind === "permission" ? pending.requestId : "";
	check(
		"live answer reports success",
		test.session.answerPermission(requestId, "yes"),
	);
	check(
		"manual answer returns selected",
		(await result).outcome.outcome === "selected",
	);
	const settled = test.updated[0];
	check(
		"answered card retains chosen label",
		settled?.kind === "permission" &&
			settled.decision === "yes" &&
			settled.decidedOptionName === "Allow once",
	);
	check(
		"second answer explicitly reports stale",
		!test.session.answerPermission(requestId, "yes"),
	);
}

// Timeout is injected so verification takes milliseconds, not ten minutes.
{
	const test = harness(10);
	const result = test.call(params);
	const request = test.appended[0];
	const requestId = request?.kind === "permission" ? request.requestId : "";
	check(
		"timeout maps to ACP cancelled",
		(await result).outcome.outcome === "cancelled",
	);
	check(
		"timeout persists expired card",
		test.updated[0]?.kind === "permission" &&
			test.updated[0].decision === "expired",
	);
	check(
		"answer after timeout explicitly reports stale",
		!test.session.answerPermission(requestId, "yes"),
	);
}

// Cancelling a turn settles its permission through the same path.
{
	const test = harness(1_000);
	const result = test.call(params);
	await test.session.cancel();
	check(
		"cancel maps permission to ACP cancelled",
		(await result).outcome.outcome === "cancelled",
	);
	check(
		"cancel persists cancelled card",
		test.updated[0]?.kind === "permission" &&
			test.updated[0].decision === "cancelled",
	);
}

// Stopping the session uses the same settlement path and clears the wait.
{
	const test = harness(1_000);
	const result = test.call(params);
	await test.session.stop();
	check("stop maps permission to ACP cancelled", (await result).outcome.outcome === "cancelled");
	check(
		"stop persists cancelled card",
		test.updated[0]?.kind === "permission" && test.updated[0].decision === "cancelled",
	);
}

// Startup reconciliation supersedes only orphaned cards.
{
	const pending: TranscriptEvent = {
		kind: "permission",
		id: "perm:old",
		ts: 1,
		requestId: "old",
		title: "Old request",
		options: [],
	};
	const answered: TranscriptEvent = {
		...pending,
		id: "perm:done",
		decision: "yes",
	};
	const reconciled = expireOrphanedPermissions([pending, answered], 42);
	check(
		"restart expires orphaned pending permission",
		reconciled.length === 1 && reconciled[0]?.decision === "expired",
	);
	check(
		"restart preserves answered cards",
		reconciled[0]?.id === pending.id && reconciled[0]?.ts === 42,
	);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
