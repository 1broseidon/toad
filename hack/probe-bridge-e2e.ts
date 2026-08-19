/**
 * Drives the real Bridge over a real unix socket against the real transcript
 * files, so both halves of the read path are exercised together: the bounded
 * tail read, and delivery of a response frame far larger than the 8 KiB kernel
 * send buffer.
 *
 * Run against a temp root that symlinks the live data:
 *   bun hack/probe-bridge-e2e.ts
 */
import { mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Outbox } from "../src/bun/mcp/protocol";

const LIVE_ROOT = join(
	process.env.HOME ?? "",
	"Library",
	"Application Support",
	"Toad",
);

const root = mkdtempSync(join(tmpdir(), "toad-bridge-e2e-"));
for (const entry of ["config.json", "transcripts", "threads"]) {
	try {
		symlinkSync(join(LIVE_ROOT, entry), join(root, entry));
	} catch {
		// threads/ may not exist yet
	}
}
process.env.TOAD_DATA_DIR = root;

const { Bridge } = await import("../src/bun/mcp/bridge");
const { listPersonas } = await import("../src/bun/store/personas");
const { BRIDGE_VERSION, flushFrames, sendFrame } = await import("../src/bun/mcp/protocol");

type ClientState = Outbox & { buffer: string };

const bridge = new Bridge({
	supervisor: { info: () => ({ state: "idle" }) } as never,
	peers: { deliver: async () => ({ ok: false, reason: "internal", detail: "n/a" }), activeDelivery: () => undefined } as never,
});

if (!(await bridge.start())) {
	console.log("FAILED: bridge did not start (socket owned elsewhere?)");
	process.exit(1);
}

const personas = listPersonas();
if (personas.length === 0) {
	console.log("FAILED: no personas in config.json");
	process.exit(1);
}
const token = "e2e-probe-token";
bridge.register(token, { kind: "human", personaId: personas[0]!.id });

const pending = new Map<number, (frame: Record<string, unknown>) => void>();
let nextId = 1;

const socket = await Bun.connect<ClientState>({
	unix: bridge.socketPath,
	data: { buffer: "", outbox: null },
	socket: {
		open(s) {
			s.data = { buffer: "", outbox: null };
		},
		drain: (s) => flushFrames(s),
		data(s, bytes) {
			s.data.buffer += bytes.toString("utf8");
			for (;;) {
				const newline = s.data.buffer.indexOf("\n");
				if (newline === -1) return;
				const line = s.data.buffer.slice(0, newline);
				s.data.buffer = s.data.buffer.slice(newline + 1);
				try {
					const frame = JSON.parse(line) as { id: number };
					pending.get(frame.id)?.(frame as unknown as Record<string, unknown>);
					pending.delete(frame.id);
				} catch {
					console.log("  !! corrupt line of", Buffer.byteLength(line), "bytes");
				}
			}
		},
	},
});

function call(method: string, params: Record<string, unknown>) {
	const id = nextId++;
	const started = performance.now();
	return new Promise<{ frame: Record<string, unknown>; ms: number; bytes: number } | null>((resolve) => {
		const timer = setTimeout(() => {
			pending.delete(id);
			resolve(null);
		}, 20_000);
		pending.set(id, (frame) => {
			clearTimeout(timer);
			resolve({ frame, ms: performance.now() - started, bytes: Buffer.byteLength(JSON.stringify(frame)) });
		});
		sendFrame(socket, `${JSON.stringify({ v: BRIDGE_VERSION, id, method, params })}\n`);
	});
}

const hello = await call("hello", { token });
console.log(`hello              ${hello ? `ok in ${hello.ms.toFixed(0)}ms` : "TIMED OUT"}`);

let failures = hello ? 0 : 1;

// Three at once, mirroring the parallel calls that timed out.
const targets = personas.slice(0, 3).map((persona) => persona.id);
const reads = await Promise.all(targets.map((target) => call("read_transcript", { target, limit: 100 })));
targets.forEach((target, index) => {
	const result = reads[index];
	const name = personas.find((persona) => persona.id === target)?.name ?? target;
	if (!result) {
		failures++;
		console.log(`read_transcript    ${name}: TIMED OUT`);
		return;
	}
	console.log(
		`read_transcript    ${name}: ${result.frame.ok ? "ok" : `error ${JSON.stringify(result.frame.error)}`}` +
			` — ${result.bytes} byte frame in ${result.ms.toFixed(0)}ms`,
	);
	if (!result.frame.ok) failures++;
});

const search = await call("search_transcripts", { query: "the", limit: 40 });
console.log(
	`search_transcripts ${search ? `${search.frame.ok ? "ok" : "error"} — ${search.bytes} byte frame in ${search.ms.toFixed(0)}ms` : "TIMED OUT"}`,
);
if (!search || !search.frame.ok) failures++;

const big = reads.filter((result) => result && result.bytes > 8192).length;
console.log(`\nframes larger than the 8 KiB send buffer: ${big}`);
console.log(failures === 0 ? "ok — every call answered" : `FAILED — ${failures} call(s) failed`);

socket.end();
bridge.stop();
process.exit(failures === 0 ? 0 : 1);
