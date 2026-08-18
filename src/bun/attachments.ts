import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, statSync, writeFileSync } from "node:fs";
import { platform } from "node:os";
import { basename, extname, join } from "node:path";
import type { Attachment } from "../shared/types";
import { attachmentsDir } from "./paths";

/**
 * Attachments, from a path or from pasted bytes.
 *
 * Toad only ever decides two things about a file: what to call it, and whether
 * it is an image. Everything past that is the agent's problem — a file is
 * handed over as a link to somewhere on disk it can already reach.
 */

const IMAGE_TYPES: Record<string, string> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".bmp": "image/bmp",
	".svg": "image/svg+xml",
	".heic": "image/heic",
};

/** What an already-existing file on disk looks like as an attachment. */
export function describe(path: string): Attachment {
	const mimeType = IMAGE_TYPES[extname(path).toLowerCase()];
	let size: number | undefined;
	try {
		const stat = statSync(path);
		// A directory has a size, but not one worth showing on a chip.
		if (stat.isFile()) size = stat.size;
	} catch {
		// A file that cannot be stat'd can still be handed over as a path; the
		// agent will report what it finds there better than a guess would.
	}
	return { kind: mimeType ? "image" : "file", name: basename(path), path, mimeType, size };
}

/**
 * Describes the paths that are really there.
 *
 * These arrive from a paste or a drop, so most of them are exactly what they
 * look like and some of them are a line of prose that happened to start with a
 * slash. Anything that does not exist is dropped rather than reported: the
 * caller falls back to treating the paste as text, which is what it was.
 */
export function resolve(paths: string[]): Attachment[] {
	return paths.filter((path) => existsSync(path)).map(describe);
}

/**
 * What the webview knows about a dropped file, which is everything except
 * where it came from.
 */
export type Fingerprint = { name: string; size: number; lastModified: number };

/** How far apart two mtimes may be and still be the same file, in seconds. */
const MTIME_SLACK = 2;

/**
 * Finds the file a drop came from, so it can be linked instead of copied.
 *
 * WebKit hands a dropped file over as bytes and a name and deliberately not as
 * a path — the filesystem is on the far side of the sandbox from web content.
 * Copying those bytes works, but it hands an agent a duplicate of a file it
 * could have opened in place, and editing the duplicate changes nothing the
 * user can see.
 *
 * So the path is recovered rather than received: Spotlight already knows every
 * indexed file's name and size, and the drop carries the original's mtime even
 * though a copy of it would not. Three matching facts and exactly one candidate
 * is the bar. Anything less certain than that returns nothing and the caller
 * keeps its copy, because a wrong path here means editing the wrong file.
 */
export function locate(prints: Fingerprint[]): (Attachment | null)[] {
	if (platform() !== "darwin") return prints.map(() => null);
	return prints.map((print) => {
		const found = spotlight(print);
		return found ? describe(found) : null;
	});
}

function spotlight(print: Fingerprint): string | null {
	// A name is user data on its way into a query language; a quote in it would
	// otherwise end the string and change what is being asked.
	if (!print.name || print.name.includes('"') || print.size <= 0) return null;

	let out: string;
	try {
		out = execFileSync(
			"mdfind",
			[`kMDItemFSName == "${print.name}" && kMDItemFSSize == ${print.size}`],
			{ encoding: "utf8", timeout: 2_000 },
		);
	} catch {
		// Spotlight off, indexing, or simply slow. A copy is still a good answer.
		return null;
	}

	const wanted = print.lastModified / 1000;
	const candidates = out
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean)
		.filter((path) => {
			try {
				return Math.abs(statSync(path).mtimeMs / 1000 - wanted) <= MTIME_SLACK;
			} catch {
				return false;
			}
		});

	// Two files that agree on all three are two copies of one thing, and there is
	// no way to tell which one was dragged. Neither is worth guessing at.
	return candidates.length === 1 ? candidates[0]! : null;
}

/**
 * Writes pasted bytes into the persona's attachments directory.
 *
 * The name is prefixed rather than trusted: it arrives from the webview, and
 * two screenshots pasted a minute apart are both called "image.png".
 */
export function save(
	personaId: string,
	name: string,
	mimeType: string,
	base64: string,
): Attachment {
	const safe = basename(name).replace(/[^\w.-]+/g, "-").slice(-64) || "pasted";
	const path = join(attachmentsDir(personaId), `${randomUUID().slice(0, 8)}-${safe}`);
	const bytes = Buffer.from(base64, "base64");
	writeFileSync(path, bytes);
	return {
		kind: mimeType.startsWith("image/") ? "image" : "file",
		name: safe,
		path,
		mimeType,
		size: bytes.byteLength,
	};
}
