import { readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { isBusy } from "../shared/session";
import type { FailedUpdate, SessionState, UpdateStatus } from "../shared/types";

/**
 * Toad's side of Electrobun's updater: map its status stream, refuse a
 * restart mid-turn, prune leftover tars, and remember a failed update.
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
/** One per update transaction, written by the native updater. */
const RESULT_FILE = /^\.electrobun-update-[a-f0-9]{32}\.result\.json$/;

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

/**
 * The newest update transaction this install recorded, when it failed.
 *
 * Electrobun writes one `.electrobun-update-<txn>.result.json` per attempt and
 * announces it exactly once: the first launch that sees a result marks the
 * transaction observed, and every launch after that stays quiet. So a desk
 * that failed to update and was then relaunched looked identical to a desk
 * that was already current — which is how a fleet-wide failure stayed
 * invisible for hours. Reading the same files ourselves is what makes a
 * failure outlive the launch that saw it. We only read them; the observed
 * marker is Electrobun's bookkeeping, not ours.
 *
 * Newest transaction wins, and a success ends the story: an install that
 * moved on has no failure to report, and Electrobun prunes the older results
 * on its next handoff anyway.
 */
export function readFailedUpdate(channelRoot: string, local: RawLocalInfo): FailedUpdate | null {
	let names: string[];
	try {
		names = readdirSync(channelRoot);
	} catch {
		return null;
	}
	let newestAt = -1;
	let newest: Record<string, unknown> | null = null;
	for (const name of names) {
		if (!RESULT_FILE.test(name)) continue;
		const path = join(channelRoot, name);
		try {
			const stat = statSync(path);
			if (!stat.isFile() || stat.size > 4096) continue;
			if (stat.mtimeMs <= newestAt) continue;
			const document: unknown = JSON.parse(readFileSync(path, "utf8"));
			if (!document || typeof document !== "object") continue;
			const result = document as Record<string, unknown>;
			if (result.schema_version !== 1) continue;
			if (typeof result.version !== "string" || typeof result.hash !== "string") continue;
			// The channel root is per-install, so a result naming another
			// channel was copied here and is not about this build.
			if (local.channel && result.channel !== local.channel) continue;
			newestAt = stat.mtimeMs;
			newest = result;
		} catch {
			// A result we cannot read is a result we cannot report.
		}
	}
	if (!newest || newest.success !== false) return null;
	/* A failure carrying the running hash is the updater declining to replace
	 * this build with itself, not a build we failed to reach. */
	if (newest.hash === local.hash) return null;
	return {
		version: newest.version as string,
		hash: newest.hash as string,
		phase: typeof newest.phase === "string" ? newest.phase : "",
		reason: typeof newest.message === "string" ? newest.message : "",
	};
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
		return { ...base, phase: "error", message: stripCheckPrefix(errorText(entry)) };
	}
	return snapshotFromInfo(local, info);
}

function stripCheckPrefix(message: string): string {
	return message.replace(/^Failed to check for updates:\s*/i, "");
}

/**
 * Electrobun reports a failure twice: `details.errorMessage` is the bare
 * native token — `InvalidUpdateIdentity` — and `message` is the sentence that
 * names the build it was reaching for and the phase it broke in. The sentence
 * is the one a person can act on, so prefer it whenever it already carries
 * the token.
 */
function errorText(entry: RawStatusEntry): string {
	const token = entry.details?.errorMessage ?? "";
	const sentence = entry.message ?? "";
	if (sentence && (!token || sentence.includes(token))) return sentence;
	return token || sentence || "The update failed.";
}

export function createDesktopUpdate(
	bridge: UpdateBridge,
	deps: {
		busyNames(): string[];
		publish(status: UpdateStatus): void;
	},
) {
	let last: UpdateStatus | null = null;
	/** `undefined` until the result files have been read once. */
	let failed: FailedUpdate | null | undefined;

	const readFailed = async (): Promise<FailedUpdate | null> => {
		if (failed !== undefined) return failed;
		try {
			const local = await bridge.getLocalInfo();
			failed = readFailedUpdate(await bridge.appDataFolder(), local);
		} catch {
			// Dev and unmanaged launches have no channel root.
			failed = null;
		}
		return failed;
	};

	/**
	 * Every status carries the failed attempt, so no surface has to have been
	 * watching when the updater spoke. The result files only change when this
	 * process updates, and that always announces itself first.
	 */
	const attach = async (status: UpdateStatus): Promise<UpdateStatus> => {
		const attempt = await readFailed();
		const next = { ...status };
		if (attempt) next.failedUpdate = attempt;
		else delete next.failedUpdate;
		return next;
	};

	const publish = async (status: UpdateStatus): Promise<UpdateStatus> => {
		const settled = await attach(status);
		last = settled;
		deps.publish(settled);
		return settled;
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
			// The transaction that produced this status may be the one on disk.
			failed = undefined;
			await publish(mapRawStatus(entry, local, info));
			if (entry.status === "download-complete" || entry.status === "complete") {
				await prune(local, info);
			}
		})();
	});

	const snapshot = async (): Promise<UpdateStatus> => {
		const local = await bridge.getLocalInfo();
		if (last && (last.phase === "blocked" || last.phase === "complete")) {
			return attach({ ...last, currentVersion: local.version, currentHash: local.hash });
		}
		return attach(snapshotFromInfo(local, bridge.getUpdateInfo()));
	};

	return {
		snapshot,
		async check(): Promise<UpdateStatus> {
			const local = await bridge.getLocalInfo();
			if (local.channel === "dev" || !local.channel || !local.baseUrl) {
				return publish(snapshotFromInfo(local, emptyInfo()));
			}
			await publish({
				phase: "checking",
				message: "Checking for updates…",
				currentVersion: local.version,
				currentHash: local.hash,
			});
			const info = await bridge.checkForUpdate();
			return publish(snapshotFromInfo(await bridge.getLocalInfo(), info));
		},
		async download(): Promise<UpdateStatus> {
			await bridge.downloadUpdate();
			const local = await bridge.getLocalInfo();
			const info = bridge.getUpdateInfo();
			await prune(local, info);
			return publish(snapshotFromInfo(local, info));
		},
		async apply(): Promise<UpdateStatus> {
			const names = deps.busyNames();
			const local = await bridge.getLocalInfo();
			const info = bridge.getUpdateInfo();
			if (names.length > 0) {
				return publish({
					phase: "blocked",
					message: blockedMessage(names),
					currentVersion: local.version,
					currentHash: local.hash,
					latestVersion: info.version || undefined,
					latestHash: info.hash || undefined,
					blockedBy: names,
				});
			}
			if (!info.updateReady) {
				return publish({
					...snapshotFromInfo(local, info),
					phase: "error",
					message: "Download the update before restarting.",
				});
			}
			await bridge.applyUpdate();
			return snapshot();
		},
	};
}

function emptyInfo(): RawUpdateInfo {
	return { version: "", hash: "", updateAvailable: false, updateReady: false, error: "" };
}
