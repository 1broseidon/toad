/**
 * The bot-experience cut, verified: capture frames land in the transcript,
 * a human at the VNC screen freezes the agent's input, and a repeated
 * click on an unchanged frame comes back warned as stuck.
 *
 * Drives a real container through the real proxy in a throwaway
 * TOAD_DATA_DIR. Needs toad-computer:dev built locally.
 *
 * Run: bun hack/verify-computer-feedback.ts
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dataDir = mkdtempSync(join(tmpdir(), "toad-feedback-verify-"));
process.env.TOAD_DATA_DIR = dataDir;
process.env.TOAD_COMPUTER_IMAGE = process.env.TOAD_COMPUTER_IMAGE ?? "toad-computer:dev";

const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { StreamableHTTPClientTransport } = await import(
	"@modelcontextprotocol/sdk/client/streamableHttp.js"
);
const { containerName } = await import("../src/bun/computer/manager");
const { computerProxyUrl } = await import("../src/bun/computer/proxy");
const { computerVncUrl } = await import("../src/bun/computer/proxy");
const { configureFrames } = await import("../src/bun/computer/frames");
const { createPersona, updatePersona, deletePersona } = await import("../src/bun/store/personas");
const { computerRecord } = await import("../src/bun/computer/store");

let passed = 0;
let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
	if (ok) passed++;
	else failed++;
	console.log(`  ${ok ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m"} ${name} ${detail}`);
};
const textOf = (r: unknown) =>
	((r as { content?: Array<{ type: string; text?: string }> }).content ?? [])
		.filter((c) => c.type === "text")
		.map((c) => c.text ?? "")
		.join("\n");

const frames: Array<{ personaId: string; kind: string; bytes: number }> = [];
configureFrames({
	append: (personaId, event) =>
		frames.push({
			personaId,
			kind: event.kind,
			bytes: event.kind === "computer_frame" ? event.dataUrl.length : 0,
		}),
});

const persona = createPersona({ name: "feedback-verify", goal: "verify the feedback cut" });
updatePersona(persona.id, { computer: { enabled: true } });
const name = containerName(persona.id);
const { token } = computerRecord(persona.id);

try {
	const client = new Client({ name: "feedback-verify", version: "0" });
	await client.connect(
		new StreamableHTTPClientTransport(new URL(computerProxyUrl(persona.id)), {
			requestInit: { headers: { Authorization: `Bearer ${token}` } },
		}),
	);

	// -- frames in the transcript ------------------------------------------
	console.log("\n\x1b[36mFrames in the transcript\x1b[0m");
	await client.callTool({ name: "capture", arguments: {} });
	await Bun.sleep(2_000);
	check("capture dropped a frame", frames.length === 1, `${frames[0]?.bytes ?? 0} chars of data URL`);
	check("frame is a jpeg data URL and small", (frames[0]?.bytes ?? 0) > 1_000 && (frames[0]?.bytes ?? 0) < 200_000);
	await client.callTool({ name: "capture", arguments: {} });
	await Bun.sleep(1_000);
	check("second capture inside the throttle window did not", frames.length === 1);

	// -- stuck detection ----------------------------------------------------
	console.log("\n\x1b[36mStuck\x1b[0m");
	const clickOnce = () => client.callTool({ name: "input", arguments: { action: "click", x: 640, y: 400 } });
	const first = await clickOnce();
	check("first click is clean", !textOf(first).includes("stuck"));
	await clickOnce();
	const third = await clickOnce();
	check("third identical click on a still frame warns", textOf(third).includes("stuck"), textOf(third).slice(-90));
	const moved = await client.callTool({ name: "input", arguments: { action: "click", x: 100, y: 100 } });
	check("a different click is clean again", !textOf(moved).includes("stuck"));

	// -- yield to human -----------------------------------------------------
	console.log("\n\x1b[36mYield to human\x1b[0m");
	const vnc = new WebSocket(computerVncUrl(persona.id));
	vnc.binaryType = "arraybuffer";
	await new Promise<void>((resolve, reject) => {
		vnc.onmessage = () => resolve();
		vnc.onerror = () => reject(new Error("vnc failed"));
	});
	await Bun.sleep(500);
	const refused = await clickOnce();
	check(
		"input refused while a human watches",
		textOf(refused).includes("human is at the screen") || refused.isError === true,
		textOf(refused).slice(0, 80),
	);
	const looking = await client.callTool({ name: "capture", arguments: {} });
	check("capture still allowed while they watch", !looking.isError);
	vnc.close();
	await Bun.sleep(1_000);
	const resumed = await clickOnce();
	check(
		"input resumes when they leave",
		!textOf(resumed).includes("human is at the screen") && resumed.isError !== true,
	);
	await client.close();
} finally {
	deletePersona(persona.id);
	await Bun.sleep(2_000);
	await Bun.$`docker rm -f ${name}`.quiet().nothrow();
	rmSync(dataDir, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
