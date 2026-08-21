/**
 * Proves the computer's screen surface end to end, the way the app uses it:
 *
 *   - GET /screenshot on the container answers a PNG, behind the token.
 *   - /vnc bridges WebSocket → RFB (the server banner arrives).
 *   - Toad's proxy re-serves both: screenshot via runningEndpoint(), and the
 *     VNC WebSocket via computerVncUrl() with `?token=` auth (bad token
 *     refused), Authorization re-attached on the inside leg.
 *
 * Uses a throwaway persona in a throwaway TOAD_DATA_DIR; needs the local
 * image (toad-computer:dev by default).
 *
 * Run: bun hack/verify-computer-screen.ts
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dataDir = mkdtempSync(join(tmpdir(), "toad-screen-verify-"));
process.env.TOAD_DATA_DIR = dataDir;
process.env.TOAD_COMPUTER_IMAGE = process.env.TOAD_COMPUTER_IMAGE ?? "toad-computer:dev";

const { containerName, ensureComputer, runningEndpoint } = await import("../src/bun/computer/manager");
const { computerProxyUrl, computerVncUrl } = await import("../src/bun/computer/proxy");
const { createPersona, updatePersona, deletePersona } = await import("../src/bun/store/personas");

let passed = 0;
let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
	if (ok) passed++;
	else failed++;
	console.log(`  ${ok ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m"} ${name} ${detail}`);
};

const persona = createPersona({ name: "screen-verify", goal: "verify the screen" });
updatePersona(persona.id, { computer: { enabled: true } });
const name = containerName(persona.id);

try {
	// -- wake and hit the container directly --------------------------------
	const endpoint = await ensureComputer({ personaId: persona.id, cwd: persona.cwd });
	const auth = { Authorization: `Bearer ${endpoint.token}` };

	const naked = await fetch(`${endpoint.baseUrl}/screenshot`);
	check("screenshot refused without token", naked.status === 401, `status=${naked.status}`);

	const shot = await fetch(`${endpoint.baseUrl}/screenshot`, { headers: auth });
	const bytes = new Uint8Array(await shot.arrayBuffer());
	check("screenshot answers", shot.ok, `status=${shot.status}`);
	check(
		"screenshot is a PNG",
		bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50,
		`${bytes.length} bytes`,
	);

	// -- RFB banner straight off the container's /vnc -----------------------
	const direct = new WebSocket(`${endpoint.baseUrl.replace("http", "ws")}/vnc`, {
		headers: auth,
	} as never);
	const directBanner = await new Promise<string>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("no banner")), 10_000);
		direct.binaryType = "arraybuffer";
		direct.onmessage = (event) => {
			clearTimeout(timer);
			resolve(new TextDecoder().decode(new Uint8Array(event.data as ArrayBuffer).slice(0, 12)));
		};
		direct.onerror = () => {
			clearTimeout(timer);
			reject(new Error("ws error"));
		};
	}).catch((error) => `ERROR: ${(error as Error).message}`);
	direct.close();
	check("container /vnc speaks RFB", directBanner.startsWith("RFB "), JSON.stringify(directBanner));

	// -- the same two doors through Toad's proxy ----------------------------
	const running = await runningEndpoint(persona.id);
	check("runningEndpoint sees the machine", running !== null);

	const proxyShot = await fetch(
		computerProxyUrl(persona.id).replace(/\/mcp$/, "/screenshot"),
		{ headers: auth },
	);
	check("proxy forwards the screenshot", proxyShot.ok, `status=${proxyShot.status}`);

	const badVnc = new WebSocket(`${computerVncUrl(persona.id).split("?")[0]}?token=wrong`);
	const badOutcome = await new Promise<string>((resolve) => {
		badVnc.onopen = () => resolve("opened");
		badVnc.onerror = () => resolve("refused");
		badVnc.onclose = () => resolve("refused");
	});
	check("proxy vnc refuses a bad token", badOutcome === "refused");

	const vnc = new WebSocket(computerVncUrl(persona.id));
	const banner = await new Promise<string>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("no banner")), 15_000);
		vnc.binaryType = "arraybuffer";
		vnc.onmessage = (event) => {
			clearTimeout(timer);
			resolve(new TextDecoder().decode(new Uint8Array(event.data as ArrayBuffer).slice(0, 12)));
		};
		vnc.onerror = () => {
			clearTimeout(timer);
			reject(new Error("ws error"));
		};
	}).catch((error) => `ERROR: ${(error as Error).message}`);
	check("proxy bridges RFB end to end", banner.startsWith("RFB "), JSON.stringify(banner));

	// The browser leg answers the version handshake; seeing bytes keep
	// flowing proves the upstream write path (browser → container) too.
	if (banner.startsWith("RFB ")) {
		vnc.send(new TextEncoder().encode("RFB 003.008\n"));
		const more = await new Promise<boolean>((resolve) => {
			const timer = setTimeout(() => resolve(false), 10_000);
			vnc.onmessage = () => {
				clearTimeout(timer);
				resolve(true);
			};
		});
		check("handshake advances through the bridge", more);
	}
	vnc.close();
} finally {
	deletePersona(persona.id);
	await Bun.sleep(2_000);
	await Bun.$`docker rm -f ${name}`.quiet().nothrow();
	rmSync(dataDir, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
