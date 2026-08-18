import {
	appendFileSync,
	closeSync,
	existsSync,
	openSync,
	readFileSync,
	readSync,
	readdirSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import type { Preview, TranscriptEvent } from "../../shared/types";
import {
	THREADS_DIR,
	ensureLayout,
	threadKey as makeThreadKey,
	threadMetaPath,
	threadPath,
} from "../paths";

export type ThreadMeta = {
	version: 1;
	a: string;
	b: string;
	sides: { user: string; agent: string };
	sessions: Array<{
		callerId: string;
		targetId: string;
		backendId: string;
		sessionId: string;
	}>;
	createdAt: number;
	updatedAt: number;
};

function writeMeta(key: string, meta: ThreadMeta): void {
	ensureLayout();
	const file = threadMetaPath(key);
	const temporary = `${file}.${process.pid}.tmp`;
	writeFileSync(temporary, `${JSON.stringify(meta, null, 2)}\n`, "utf8");
	renameSync(temporary, file);
}

export function append(key: string, event: TranscriptEvent): void {
	ensureLayout();
	appendFileSync(threadPath(key), `${JSON.stringify(event)}\n`, "utf8");
}

export function load(key: string): TranscriptEvent[] {
	const file = threadPath(key);
	if (!existsSync(file)) return [];
	const order: string[] = [];
	const byId = new Map<string, TranscriptEvent>();
	for (const line of readFileSync(file, "utf8").split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			const event = JSON.parse(trimmed) as TranscriptEvent;
			if (!event || typeof event.id !== "string") continue;
			if (!byId.has(event.id)) order.push(event.id);
			byId.set(event.id, event);
		} catch {
			// An unclean exit can leave one torn final line.
		}
	}
	return order.map((id) => byId.get(id)!).filter(Boolean);
}

const TAIL_BYTES = 64 * 1024;

export function preview(key: string): Preview | null {
	const file = threadPath(key);
	if (!existsSync(file)) return null;
	const size = statSync(file).size;
	const length = Math.min(size, TAIL_BYTES);
	const buffer = Buffer.alloc(length);
	const handle = openSync(file, "r");
	try {
		readSync(handle, buffer, 0, length, size - length);
	} finally {
		closeSync(handle);
	}
	const lines = buffer.toString("utf8").split("\n");
	for (let index = lines.length - 1; index >= 0; index--) {
		const line = lines[index]?.trim();
		if (!line) continue;
		try {
			const event = JSON.parse(line) as TranscriptEvent;
			if (event.kind === "user" || event.kind === "agent") {
				return { from: event.kind === "user" ? "me" : "them", text: event.text, at: event.ts };
			}
		} catch {
			// Ignore a partial line at the beginning or end of the tail.
		}
	}
	return null;
}

export function compact(key: string): void {
	const events = load(key);
	if (events.length === 0) return;
	writeFileSync(threadPath(key), `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
}

export function ensure(key: string, a: string, b: string): ThreadMeta {
	if (makeThreadKey(a, b) !== key) throw new Error("Thread key does not match participants");
	const existing = readMeta(key);
	if (existing) return existing;
	const [lo, hi] = [a, b].sort();
	const timestamp = Date.now();
	const meta: ThreadMeta = {
		version: 1,
		a: lo!,
		b: hi!,
		sides: { user: lo!, agent: hi! },
		sessions: [],
		createdAt: timestamp,
		updatedAt: timestamp,
	};
	writeMeta(key, meta);
	return meta;
}

export function readMeta(key: string): ThreadMeta | null {
	const file = threadMetaPath(key);
	if (!existsSync(file)) return null;
	try {
		const meta = JSON.parse(readFileSync(file, "utf8")) as ThreadMeta;
		return meta?.version === 1 ? meta : null;
	} catch {
		return null;
	}
}

export function checkpointPeerSession(
	key: string,
	callerId: string,
	targetId: string,
	backendId: string,
	sessionId: string,
): void {
	const meta = readMeta(key);
	if (!meta) throw new Error("Peer thread metadata is missing");
	meta.sessions = meta.sessions.filter(
		(item) =>
			!(
				item.callerId === callerId &&
				item.targetId === targetId &&
				item.backendId === backendId
			),
	);
	meta.sessions.push({ callerId, targetId, backendId, sessionId });
	meta.updatedAt = Date.now();
	writeMeta(key, meta);
}

export function listAllKeys(): string[] {
	ensureLayout();
	return readdirSync(THREADS_DIR)
		.filter((name) => name.endsWith(".json"))
		.map((name) => name.slice(0, -".json".length))
		.filter((key) => {
			try {
				return threadMetaPath(key).startsWith(THREADS_DIR);
			} catch {
				return false;
			}
		});
}

export function listKeysFor(personaId: string): string[] {
	return listAllKeys().filter((key) => key.split("~").includes(personaId));
}

export function dropPersona(personaId: string): void {
	for (const key of listKeysFor(personaId)) {
		rmSync(threadPath(key), { force: true });
		rmSync(threadMetaPath(key), { force: true });
	}
}
