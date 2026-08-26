import {
	closeSync,
	copyFileSync,
	existsSync,
	fsyncSync,
	openSync,
	readFileSync,
	renameSync,
	writeSync,
} from "node:fs";

/**
 * Reading and writing the small JSON files whose loss is not recoverable.
 *
 * A roster is not a cache. Two ordinary habits put one at risk, and both have
 * cost real data:
 *
 *  1. `writeFileSync` truncates the file and then writes it. An update that
 *     restarts the machine, or a crash between those two steps, leaves a file
 *     that exists and holds nothing.
 *  2. A reader that answers "empty" for a file it could not parse invites the
 *     next mutation — a checkpoint after any turn is enough — to save that
 *     emptiness over the only copy.
 *
 * So writes here land atomically and leave the previous good copy beside them,
 * and an unparseable file is reported as damaged rather than mistaken for
 * absent. Callers that own irreplaceable state must refuse to write while
 * damaged; erasing on the user's behalf is never the safer default.
 */

export type Loaded<T> = {
	/** Parsed contents. Null when the file is absent or beyond recovery. */
	value: T | null;
	/** The file is there, neither it nor its backup parsed. Do not overwrite. */
	damaged: boolean;
	/** The live file was unreadable and the backup answered instead. */
	recovered: boolean;
};

function backupPath(file: string): string {
	return `${file}.bak`;
}

function parse<T>(file: string): T | null {
	try {
		return JSON.parse(readFileSync(file, "utf8")) as T;
	} catch {
		return null;
	}
}

/**
 * Loads a file, falling back to its backup before admitting defeat.
 *
 * A missing file is absent, not damaged: deleting one is a legitimate way to
 * ask for a fresh start, and the atomic write below means the app never loses
 * it by accident.
 */
export function loadJson<T>(file: string): Loaded<T> {
	if (!existsSync(file)) return { value: null, damaged: false, recovered: false };

	const value = parse<T>(file);
	if (value !== null) return { value, damaged: false, recovered: false };

	const rescued = existsSync(backupPath(file)) ? parse<T>(backupPath(file)) : null;
	if (rescued !== null) return { value: rescued, damaged: false, recovered: true };

	return { value: null, damaged: true, recovered: false };
}

/** Writes a file whole or not at all, keeping the copy it replaces. */
export function saveJson(file: string, value: unknown): void {
	const text = `${JSON.stringify(value, null, 2)}\n`;
	const temporary = `${file}.${process.pid}.tmp`;

	const handle = openSync(temporary, "w");
	try {
		writeSync(handle, text);
		// The rename is atomic with respect to the name, not to the bytes. Without
		// this, a power cut just after an update can leave the real name pointing
		// at a file the kernel had not finished writing.
		fsyncSync(handle);
	} finally {
		closeSync(handle);
	}

	renameSync(temporary, file);

	// Mirrored after the rename, not before it, so the backup always holds
	// content that really went live — and holds the newest such content rather
	// than lagging a write behind, which would quietly discard the last change
	// on the one occasion the backup is needed.
	try {
		copyFileSync(file, backupPath(file));
	} catch {
		/* A saved file with no spare copy still beats refusing to save. */
	}
}
