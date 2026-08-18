import type { Attachment } from "../shared/types";
import { api } from "./rpc";

/**
 * Turning a paste or a drop into attachments.
 *
 * The order matters more than anything else here, and all of it is working
 * around one fact: WebKit will not tell web content where a dropped file lives.
 * The bytes come through, the path does not. Taking the bytes always works, and
 * it also hands the agent a duplicate of a file it could have opened in place —
 * so edits land on Toad's copy and the user's own file never changes.
 *
 * So a real path is worth some trouble to get. It is read off the pasteboard
 * when it is there, recovered from Spotlight when it is not, and only when both
 * fail are the bytes written down — which in practice means a screenshot, the
 * one case where there is genuinely no file to point at.
 */
export async function ingest(personaId: string, source: DataTransfer): Promise<Attachment[]> {
	const paths = pathsFrom(source);
	if (paths.length > 0) {
		const resolved = await api.resolveAttachments(paths);
		if (resolved.length > 0) return resolved;
	}

	const files = Array.from(source.files);
	if (files.length === 0) return [];

	// Where each file came from, if it can be worked out. `lastModified` is the
	// original's, which is the one fact a copy of it would not carry.
	const located = await api
		.locateAttachments(
			files.map((file) => ({
				name: file.name,
				size: file.size,
				lastModified: file.lastModified,
			})),
		)
		.catch(() => files.map(() => null));

	return Promise.all(
		files.map(
			async (file, index) =>
				located[index] ??
				api.saveAttachment(
					personaId,
					file.name || `pasted${extensionFor(file.type)}`,
					file.type || "application/octet-stream",
					await asBase64(file),
				),
		),
	);
}

/** Whether a paste is worth intercepting before the field sees it. */
export const looksLikePaths = (source: DataTransfer): boolean =>
	pathsFrom(source).length > 0 || source.files.length > 0;

/**
 * Local paths named by a transfer, from the URL flavours first and the plain
 * text one after.
 *
 * The text flavour is what makes pasting a path out of a terminal work. It is
 * only trusted as far as looking absolute — whether anything is actually there
 * is settled on the other side of the wire, by the process that can look.
 */
function pathsFrom(source: DataTransfer): string[] {
	const lines = [source.getData("text/uri-list"), source.getData("text/plain")]
		.filter(Boolean)
		.flatMap((blob) => blob.split(/\r?\n/))
		// `#` opens a comment in a uri-list, and never a path we would want.
		.map((line) => line.trim())
		.filter((line) => line && !line.startsWith("#"));

	const paths: string[] = [];
	for (const line of lines) {
		if (line.startsWith("file://")) {
			try {
				paths.push(decodeURIComponent(new URL(line).pathname));
			} catch {
				// A malformed file URL is not a path; let it fall through as text.
			}
		} else if (line.startsWith("/")) {
			paths.push(line);
		}
	}
	return Array.from(new Set(paths));
}

const asBase64 = (file: File): Promise<string> =>
	file.arrayBuffer().then((buffer) => {
		// In chunks, because spreading a few megabytes into String.fromCharCode at
		// once overruns the argument limit.
		const bytes = new Uint8Array(buffer);
		let binary = "";
		for (let index = 0; index < bytes.length; index += 0x8000) {
			binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
		}
		return btoa(binary);
	});

const extensionFor = (mimeType: string): string => {
	const subtype = mimeType.split("/")[1];
	return subtype ? `.${subtype.split("+")[0]}` : "";
};
