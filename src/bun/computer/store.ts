import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { COMPUTERS_FILE, ensureLayout } from "../paths";
import type { HandshakeCache } from "./cache";

/**
 * State Toad derives about each teammate's computer, kept apart from config:
 * the bearer token (a secret Toad generated, docs/computer.md §Security) and
 * the last time the computer was used (which drives the stop/hibernate
 * timers across app restarts).
 *
 * The token outlives the container on purpose. Hibernation is `rm`, and the
 * wake after it recreates the container with the same token, so the injected
 * server config a running session already holds keeps working.
 */
export type ComputerRecord = {
	personaId: string;
	token: string;
	lastUsedAt: number;
	handshake?: HandshakeCache;
};

type StoreFile = { version: 1; computers: ComputerRecord[] };

function read(): StoreFile {
	ensureLayout();
	if (!existsSync(COMPUTERS_FILE)) return { version: 1, computers: [] };
	try {
		const parsed = JSON.parse(readFileSync(COMPUTERS_FILE, "utf8")) as StoreFile;
		return Array.isArray(parsed.computers) ? parsed : { version: 1, computers: [] };
	} catch {
		return { version: 1, computers: [] };
	}
}

function write(store: StoreFile): void {
	ensureLayout();
	writeFileSync(COMPUTERS_FILE, `${JSON.stringify(store, null, 2)}\n`, "utf8");
}

export function computerRecord(personaId: string): ComputerRecord {
	const store = read();
	const existing = store.computers.find((r) => r.personaId === personaId);
	if (existing) return existing;

	const record: ComputerRecord = {
		personaId,
		token: randomBytes(32).toString("hex"),
		lastUsedAt: Date.now(),
	};
	store.computers.push(record);
	write(store);
	return record;
}

export function listComputerRecords(): ComputerRecord[] {
	return read().computers;
}

export function touchComputer(personaId: string): void {
	const store = read();
	const record = store.computers.find((r) => r.personaId === personaId);
	if (!record) return;
	record.lastUsedAt = Date.now();
	write(store);
}

export function forgetComputer(personaId: string): void {
	const store = read();
	const next = store.computers.filter((r) => r.personaId !== personaId);
	if (next.length === store.computers.length) return;
	write({ version: 1, computers: next });
}

export function handshakeCache(personaId: string): HandshakeCache | undefined {
	return computerRecord(personaId).handshake;
}

export function saveHandshakeCache(personaId: string, next: HandshakeCache): void {
	const store = read();
	const record = store.computers.find((r) => r.personaId === personaId);
	if (!record) return;
	const prev = record.handshake;
	record.handshake =
		prev && prev.image === next.image
			? { ...next, results: { ...prev.results, ...next.results } }
			: next;
	write(store);
}
