/**
 * The web wire's liveness contract, from the phone's side of it.
 *
 * The transport now heartbeats an app-level `ping` and treats *any* answer
 * as life — so what the server must guarantee is narrow and testable: a
 * linked socket answers `ping` with true, answers an unknown method with an
 * error frame rather than silence (an old desktop must still prove the wire),
 * and a broadcast reaches a client that connected after others dropped.
 *
 *   bun scripts/verify-web-live.ts
 *
 * The desktop's own handler map is not imported here (importing index.ts
 * boots the app); that `ping` exists there is enforced by the ToadRPC
 * contract at typecheck. This drives the real server with a stand-in map.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.TOAD_DATA_DIR = mkdtempSync(join(tmpdir(), "toad-web-live-"));
// Ports the machine's real Toad is not sitting on.
process.env.TOAD_WEB_HTTPS_PORT = "45443";
/* The seat's loopback door, off its fixed default so this run never takes a
   port a live desk is holding. */
process.env.TOAD_WEB_LOOPBACK_PORT = "45682";
const PORT = 44680;

const { startWebMode, stopWebMode, webBroadcast } = await import("../src/bun/web/server");
const { createPairing, claimPairing } = await import("../src/bun/web/devices");

const handlers: Record<string, (params: unknown) => Promise<unknown>> = {
	ping: async () => true,
};

startWebMode((method) => handlers[method], PORT);
const device = claimPairing(createPairing(), "verify-live-phone");
if (!device) throw new Error("pairing should claim");

function connect(): Promise<WebSocket> {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${device!.token}`);
		ws.onopen = () => resolve(ws);
		ws.onerror = () => reject(new Error("socket refused"));
	});
}

/** One frame in, the matching frame out, or a loud timeout. */
function ask(ws: WebSocket, frame: object, match: (got: any) => boolean): Promise<any> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`no answer to ${JSON.stringify(frame)}`)), 3_000);
		const listener = (event: MessageEvent) => {
			const got = JSON.parse(String(event.data));
			if (!match(got)) return;
			clearTimeout(timer);
			ws.removeEventListener("message", listener);
			resolve(got);
		};
		ws.addEventListener("message", listener);
		ws.send(JSON.stringify(frame));
	});
}

const ws = await connect();

// The heartbeat's happy path: ping answers true.
const pong = await ask(ws, { id: 1, method: "ping", params: {} }, (got) => got.id === 1);
if (pong.ok !== true || pong.result !== true) {
	throw new Error(`ping should answer true, got ${JSON.stringify(pong)}`);
}

// The old-desktop path: an unknown method is refused, not ignored. The
// probe counts this refusal as life, so silence here would strand phones
// linked to desktops that predate ping.
const refused = await ask(ws, { id: 2, method: "no-such-method", params: {} }, (got) => got.id === 2);
if (refused.ok !== false || !String(refused.error).includes("no-such-method")) {
	throw new Error(`unknown method should answer an error frame, got ${JSON.stringify(refused)}`);
}

// The resync path rides pushes once the wire is back: a fresh socket hears
// broadcasts made after older sockets died.
const dead = await connect();
dead.close();
await new Promise((resolve) => setTimeout(resolve, 100));
const heard = new Promise<any>((resolve, reject) => {
	const timer = setTimeout(() => reject(new Error("broadcast never arrived")), 3_000);
	ws.addEventListener("message", (event: MessageEvent) => {
		const got = JSON.parse(String(event.data));
		if (got.push !== "transcriptAppended") return;
		clearTimeout(timer);
		resolve(got);
	});
});
webBroadcast("transcriptAppended", { personaId: "p1", event: { id: "e1" } });
const push = await heard;
if (push.payload?.personaId !== "p1") throw new Error("broadcast payload should survive the wire");

// The revocation probe is a cross-origin fetch from the native shell:
// without CORS on the /ws answer the 401 is unreadable and a revoked
// phone knocks forever. The header is the contract; pin it.
const denied = await fetch(`http://127.0.0.1:${PORT}/ws?token=not-a-token`);
if (denied.status !== 401) throw new Error(`bad token should 401, got ${denied.status}`);
if (denied.headers.get("access-control-allow-origin") !== "*") {
	throw new Error("/ws 401 must carry access-control-allow-origin for the native probe");
}

ws.close();
stopWebMode();
console.log("ping answers, refusals answer, broadcasts reach the living — the wire holds");
