import { readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { isBusy } from "../shared/session";
import type { SessionState, UpdateStatus } from "../shared/types";

/**
 * Toad's side of Electrobun's updater: map its status stream, refuse a
 * restart mid-turn, and prune leftover tars.
 *
 * The native check/download/apply lives in Electrobun. This file is the
 * policy around it, and it takes a bridge so the policy can be tested
 * without spinning up a packaged app.
 */

export type RawUpdateInfo = {
	version: string;
	hash: string;
	updateAvailable: boolean;
	updateReady: boolean;
	error: string;
};

export type RawLocalInfo = {
	version: string;
	hash: string;
	channel: string;
	baseUrl: string;
};

export type RawStatusEntry = {
	status: string;
	message: string;
	details?: {
		progress?: number;
		bytesDownloaded?: number;
		totalBytes?: number;
		errorMessage?: string;
	};
};

export type UpdateBridge = {
	getLocalInfo(): Promise<RawLocalInfo>;
	getUpdateInfo(): RawUpdateInfo;
	checkForUpdate(): Promise<RawUpdateInfo>;
	downloadUpdate(): Promise<void>;
	applyUpdate(): Promise<void>;
	onStatusChange(callback: ((entry: RawStatusEntry) => void) | null): void;
	appDataFolder(): Promise<string>;
};

const RETAINED_TAR = /^[a-z0-9]{1,13}\.tar$/;

const DOWNLOADING = new Set([
	"downloading",
	"download-starting",
	"checking-local-tar",
	"local-tar-found",
	"local-tar-missing",
	"fetching-patch",
	"patch-found",
	"patch-not-found",
	"downloading-patch",
	"applying-patch",
	"patch-applied",
	"patch-failed",
	"extracting-version",
	"patch-chain-complete",
	"downloading-full-bundle",
	"download-progress",
	"decompressing",
]);

const APPLYING = new Set(["applying", "extracting", "replacing-app", "launching-new-version"]);

/** Names of sessions that are mid-turn or still coming up. */
export function busySessionNames(
	sessions: Array<{ name: string; state: SessionState }>,
): string[] {
	return sessions.filter((session) => isBusy(session.state)).map((session) => session.name);
}

export function blockedMessage(names: string[]): string {
	if (names.length === 0) return "Can't restart while a teammate is still working.";
	if (names.length === 1) return `Can't restart while ${names[0]} is still working.`;
	if (names.length === 2) {
		return `Can't restart while ${names[0]} and ${names[1]} are still working.`;
	}
	const lead = names.slice(0, -1).join(", ");
	return `Can't restart while ${lead}, and ${names[names.length - 1]} are still working.`;
}

/**
 * Drop retained update tars that are neither the running build nor the
 * prepared one. Each is ~140 MB; leftover hashes from earlier installs
 * otherwise sit forever.
 */
export function pruneStaleArchives(extractionDir: string, keepHashes: Iterable<string>): string[] {
	const keep = new Set([...keepHashes].filter(Boolean));
	let names: string[];
	try {
		names = readdirSync(extractionDir);
	} catch {
		return [];
	}
	const removed: string[] = [];
	for (const name of names) {
		if (!RETAINED_TAR.test(name)) continue;
		const hash = name.slice(0, -".tar".length);
		if (keep.has(hash)) continue;
		const path = join(extractionDir, name);
		try {
			const stat = statSync(path);
			if (!stat.isFile()) continue;
			rmSync(path);
			removed.push(path);
		} catch {
			// A file we cannot unlink is left for the next pass.
		}
	}
	return removed;
}

export function snapshotFromInfo(local: RawLocalInfo, info: RawUpdateInfo): UpdateStatus {
	const base = {
		currentVersion: local.version,
		currentHash: local.hash,
		latestVersion: info.version || undefined,
		latestHash: info.hash || undefined,
	};
	if (local.channel === "dev") {
		return { ...base, phase: "idle", message: "Dev builds do not update." };
	}
	if (!local.channel) {
		return {
			...base,
			phase: "idle",
			message: "This is an unreleased build. Updates are only for installed releases.",
		};
	}
	if (!local.baseUrl) {
		return {
			...base,
			phase: "error",
			message: "This build has no update server configured.",
		};
	}
	if (info.error) {
		return { ...base, phase: "error", message: stripCheckPrefix(info.error) };
	}
	if (info.updateReady) {
		return {
			...base,
			phase: "ready",
			message: info.version
				? `${info.version} is ready. Restart to update.`
				: "The update is ready. Restart to apply it.",
		};
	}
	if (info.updateAvailable) {
		return {
			...base,
			phase: "available",
			message: info.version ? `${info.version} is available.` : "A newer build is available.",
		};
	}
	return {
		...base,
		phase: "idle",
		message: local.version ? `You're on ${local.version}.` : "No update has been checked yet.",
	};
}

export function mapRawStatus(
	entry: RawStatusEntry,
	local: RawLocalInfo,
	info: RawUpdateInfo,
): UpdateStatus {
	const base = {
		currentVersion: local.version,
		currentHash: local.hash,
		latestVersion: info.version || undefined,
		latestHash: info.hash || undefined,
		progress: entry.details?.progress,
		bytesDownloaded: entry.details?.bytesDownloaded,
		totalBytes: entry.details?.totalBytes,
	};
	if (entry.status === "checking") {
		return { ...base, phase: "checking", message: "Checking for updates…" };
	}
	if (entry.status === "update-available") {
		return {
			...base,
			phase: "available",
			message: info.version ? `${info.version} is available.` : "A newer build is available.",
		};
	}
	if (entry.status === "no-update") {
		if (local.channel === "dev") {
			return { ...base, phase: "idle", message: "Dev builds do not update." };
		}
		return {
			...base,
			phase: "idle",
			message: local.version
				? `You're on ${local.version} — the latest.`
				: "Already on the latest build.",
		};
	}
	if (DOWNLOADING.has(entry.status)) {
		const progress = entry.details?.progress;
		return {
			...base,
			phase: "downloading",
			message: progress != null ? `Downloading update… ${progress}%` : "Downloading update…",
		};
	}
	if (entry.status === "download-complete") {
		return {
			...base,
			phase: "ready",
			message: info.version
				? `${info.version} is ready. Restart to update.`
				: "The update is ready. Restart to apply it.",
		};
	}
	if (APPLYING.has(entry.status)) {
		return { ...base, phase: "applying", message: "Restarting to apply the update…" };
	}
	if (entry.status === "complete") {
		return {
			...base,
			phase: "complete",
			message: info.version || local.version
				? `Updated to ${info.version || local.version}.`
				: "Update completed.",
		};
	}
	if (entry.status === "error") {
		return {
			...base,
			phase: "error",
			message: stripCheckPrefix(
				entry.details?.errorMessage || entry.message || "The update failed.",
			),
		};
	}
	return snapshotFromInfo(local, info);
}

function stripCheckPrefix(message: string): string {
	return message.replace(/^Failed to check for updates:\s*/i, "");
}

export function createDesktopUpdate(
	bridge: UpdateBridge,
	deps: {
		busyNames(): string[];
		publish(status: UpdateStatus): void;
	},
) {
	let last: UpdateStatus | null = null;

	const publish = (status: UpdateStatus) => {
		last = status;
		deps.publish(status);
	};

	const prune = async (local: RawLocalInfo, info: RawUpdateInfo) => {
		try {
			const root = await bridge.appDataFolder();
			pruneStaleArchives(join(root, "self-extraction"), [local.hash, info.hash]);
		} catch {
			// Dev and unmanaged launches have no channel root.
		}
	};

	// Register immediately: Electrobun only reconciles a post-update result
	// file once something is listening.
	bridge.onStatusChange((entry) => {
		void (async () => {
			const local = await bridge.getLocalInfo();
			const info = bridge.getUpdateInfo();
			publish(mapRawStatus(entry, local, info));
			if (entry.status === "download-complete" || entry.status === "complete") {
				await prune(local, info);
			}
		})();
	});

	const snapshot = async (): Promise<UpdateStatus> => {
		const local = await bridge.getLocalInfo();
		if (last && (last.phase === "blocked" || last.phase === "complete")) {
			return { ...last, currentVersion: local.version, currentHash: local.hash };
		}
		return snapshotFromInfo(local, bridge.getUpdateInfo());
	};

	return {
		snapshot,
		async check(): Promise<UpdateStatus> {
			const local = await bridge.getLocalInfo();
			if (local.channel === "dev" || !local.channel || !local.baseUrl) {
				const status = snapshotFromInfo(local, emptyInfo());
				publish(status);
				return status;
			}
			publish({
				phase: "checking",
				message: "Checking for updates…",
				currentVersion: local.version,
				currentHash: local.hash,
			});
			const info = await bridge.checkForUpdate();
			const status = snapshotFromInfo(await bridge.getLocalInfo(), info);
			publish(status);
			return status;
		},
		async download(): Promise<UpdateStatus> {
			await bridge.downloadUpdate();
			const local = await bridge.getLocalInfo();
			const info = bridge.getUpdateInfo();
			await prune(local, info);
			const status = snapshotFromInfo(local, info);
			publish(status);
			return status;
		},
		async apply(): Promise<UpdateStatus> {
			const names = deps.busyNames();
			const local = await bridge.getLocalInfo();
			const info = bridge.getUpdateInfo();
			if (names.length > 0) {
				const status: UpdateStatus = {
					phase: "blocked",
					message: blockedMessage(names),
					currentVersion: local.version,
					currentHash: local.hash,
					latestVersion: info.version || undefined,
					latestHash: info.hash || undefined,
					blockedBy: names,
				};
				publish(status);
				return status;
			}
			if (!info.updateReady) {
				const status: UpdateStatus = {
					...snapshotFromInfo(local, info),
					phase: "error",
					message: "Download the update before restarting.",
				};
				publish(status);
				return status;
			}
			await bridge.applyUpdate();
			return snapshot();
		},
	};
}

function emptyInfo(): RawUpdateInfo {
	return { version: "", hash: "", updateAvailable: false, updateReady: false, error: "" };
}
