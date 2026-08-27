/**
 * A unix-socket write only accepts what fits in the kernel send buffer (8 KiB
 * on macOS), so a bridge frame larger than that loses its tail unless the
 * remainder is queued and flushed on `drain`. This checks both behaviours: raw
 * `socket.write` drops, and `sendFrame`/`flushFrames` from protocol.ts do not.
 *
 * Run: bun scripts/probe-socket-write.ts
 */
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { flushFrames, sendFrame, type Outbox } from "../src/bun/mcp/protocol";

const SIZES = [4_000, 20_000, 200_000];

type State = Outbox & { buffer: string };

async function trial(mode: "raw" | "queued"): Promise<Map<number, boolean>> {
	const socketPath = join(tmpdir(), `toad-write-${mode}-${process.pid}.sock`);
	const arrived = new Map<number, boolean>();

	const listener = Bun.listen<State>({
		unix: socketPath,
		data: { buffer: "", outbox: null },
		socket: {
			open(socket) {
				socket.data = { buffer: "", outbox: null };
			},
			data(socket, bytes) {
				const frame = `${JSON.stringify({ payload: "x".repeat(Number(bytes.toString().trim())) })}\n`;
				if (mode === "raw") socket.write(frame);
				else sendFrame(socket, frame);
			},
			drain(socket) {
				if (mode === "queued") flushFrames(socket);
			},
		},
	});

	const client = await Bun.connect<State>({
		unix: socketPath,
		data: { buffer: "", outbox: null },
		socket: {
			open(socket) {
				socket.data = { buffer: "", outbox: null };
			},
			data(socket, bytes) {
				socket.data.buffer += bytes.toString("utf8");
				for (;;) {
					const newline = socket.data.buffer.indexOf("\n");
					if (newline === -1) return;
					const line = socket.data.buffer.slice(0, newline);
					socket.data.buffer = socket.data.buffer.slice(newline + 1);
					try {
						arrived.set((JSON.parse(line) as { payload: string }).payload.length, true);
					} catch {
						arrived.set(-1, true);
					}
				}
			},
		},
	});

	for (const size of SIZES) {
		client.write(`${size}\n`);
		await Bun.sleep(300);
	}
	await Bun.sleep(500);

	client.end();
	listener.stop(true);
	try {
		unlinkSync(socketPath);
	} catch {
		// best effort
	}
	return arrived;
}

const raw = await trial("raw");
const queued = await trial("queued");

console.log("payload      socket.write   sendFrame");
let failures = 0;
for (const size of SIZES) {
	const rawOk = raw.has(size);
	const queuedOk = queued.has(size);
	if (!queuedOk) failures++;
	console.log(
		`${String(size).padStart(7)}      ${(rawOk ? "arrived" : "LOST").padEnd(13)}  ${queuedOk ? "arrived" : "LOST"}`,
	);
}
if (queued.has(-1)) {
	failures++;
	console.log("\nsendFrame produced a corrupt line");
}
console.log(failures === 0 ? "\nok — queued writes deliver every frame intact" : "\nFAILED");
process.exit(failures === 0 ? 0 : 1);
