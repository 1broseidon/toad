import { registerPlugin } from "@capacitor/core";
import { nativeShell } from "./platform";

/**
 * The app-group inbox the share extension fills — see ShareInboxPlugin.swift.
 *
 * Files arrive as base64 because that is the shape `saveAttachment` already
 * takes over the wire; texts are lines for the composer. Draining empties
 * the inbox, so whoever calls this owns delivering what came back.
 */

export type SharedFile = { name: string; mimeType: string; data: string };
export type SharedItems = { files: SharedFile[]; texts: string[] };

const EMPTY: SharedItems = { files: [], texts: [] };

const inbox = registerPlugin<{ drain(): Promise<SharedItems> }>("ShareInbox");

export async function drainShareInbox(): Promise<SharedItems> {
	if (!nativeShell()) return EMPTY;
	try {
		const drained = await inbox.drain();
		return {
			files: drained.files ?? [],
			texts: drained.texts ?? [],
		};
	} catch (error) {
		console.error(`[share-inbox] drain failed: ${error instanceof Error ? error.message : String(error)}`);
		return EMPTY;
	}
}
