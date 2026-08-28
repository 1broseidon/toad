import { existsSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
	blockedMessage,
	busySessionNames,
	createDesktopUpdate,
	mapRawStatus,
	pruneStaleArchives,
	readFailedUpdate,
	snapshotFromInfo,
	type RawLocalInfo,
	type RawUpdateInfo,
	type UpdateBridge,
} from "./update";
import type { UpdateStatus } from "../shared/types";

const local: RawLocalInfo = {
	version: "0.2.0",
	hash: "abc123",
	channel: "stable",
	baseUrl: "https://toad.team/releases",
};

const none: RawUpdateInfo = {
	version: "",
	hash: "",
	updateAvailable: false,
	updateReady: false,
	error: "",
};

describe("busySessionNames", () => {
	test("only thinking and starting count", () => {
		expect(
			busySessionNames([
				{ name: "Ada", state: "thinking" },
				{ name: "Ben", state: "starting" },
				{ name: "Cara", state: "ready" },
				{ name: "Dee", state: "idle" },
			]),
		).toEqual(["Ada", "Ben"]);
	});
});

describe("blockedMessage", () => {
	test("names the teammates in a sentence", () => {
		expect(blockedMessage(["Ada"])).toBe("Can't restart while Ada is still working.");
		expect(blockedMessage(["Ada", "Ben"])).toBe(
			"Can't restart while Ada and Ben are still working.",
		);
		expect(blockedMessage(["Ada", "Ben", "Cara"])).toBe(
			"Can't restart while Ada, Ben, and Cara are still working.",
		);
	});
});

describe("pruneStaleArchives", () => {
	test("keeps only the named hashes", () => {
		const dir = mkdtempSync(join(tmpdir(), "toad-update-prune-"));
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "abc123.tar"), "keep-current");
		writeFileSync(join(dir, "def456.tar"), "keep-prepared");
		writeFileSync(join(dir, "oldhash1.tar"), "drop");
		writeFileSync(join(dir, "notes.txt"), "leave");
		writeFileSync(join(dir, ".partial.tar"), "leave");
		const removed = pruneStaleArchives(dir, ["abc123", "def456"]);
		expect(removed).toEqual([join(dir, "oldhash1.tar")]);
		expect(existsSync(join(dir, "abc123.tar"))).toBe(true);
		expect(existsSync(join(dir, "oldhash1.tar"))).toBe(false);
		expect(existsSync(join(dir, "notes.txt"))).toBe(true);
	});

	test("missing directory is a no-op", () => {
		expect(pruneStaleArchives(join(tmpdir(), "toad-update-missing"), ["abc"])).toEqual([]);
	});
});

describe("snapshotFromInfo", () => {
	test("dev and unreleased do not look for a server", () => {
		expect(snapshotFromInfo({ ...local, channel: "dev" }, none).message).toBe(
			"Dev builds do not update.",
		);
		expect(snapshotFromInfo({ ...local, channel: "" }, none).phase).toBe("idle");
	});

	test("empty baseUrl is an error on a real channel", () => {
		const status = snapshotFromInfo({ ...local, baseUrl: "" }, none);
		expect(status.phase).toBe("error");
		expect(status.message).toContain("no update server");
	});

	test("available and ready follow Electrobun's flags", () => {
		expect(
			snapshotFromInfo(local, {
				version: "0.2.1",
				hash: "zzz",
				updateAvailable: true,
				updateReady: false,
				error: "",
			}).phase,
		).toBe("available");
		expect(
			snapshotFromInfo(local, {
				version: "0.2.1",
				hash: "zzz",
				updateAvailable: true,
				updateReady: true,
				error: "",
			}).phase,
		).toBe("ready");
	});
});

describe("mapRawStatus", () => {
	test("progress stays a download, complete is a sentence", () => {
		expect(
			mapRawStatus(
				{ status: "download-progress", message: "", details: { progress: 40 } },
				local,
				none,
			),
		).toMatchObject({ phase: "downloading", progress: 40 });
		expect(
			mapRawStatus({ status: "complete", message: "" }, local, { ...none, version: "0.2.1" })
				.message,
		).toBe("Updated to 0.2.1.");
	});

	test("an error keeps the sentence, not the bare native token", () => {
		const sentence = "Update to 0.2.1 failed during validating_payload: InvalidUpdateIdentity";
		expect(
			mapRawStatus(
				{ status: "error", message: sentence, details: { errorMessage: "InvalidUpdateIdentity" } },
				local,
				none,
			).message,
		).toBe(sentence);
	});
});

const TXN_A = "a".repeat(32);
const TXN_B = "b".repeat(32);

function resultDir(
	entries: Array<{ txn: string; at: number; body: Record<string, unknown> }>,
): string {
	const dir = mkdtempSync(join(tmpdir(), "toad-update-result-"));
	for (const entry of entries) {
		const path = join(dir, `.electrobun-update-${entry.txn}.result.json`);
		writeFileSync(path, JSON.stringify(entry.body));
		utimesSync(path, entry.at, entry.at);
	}
	return dir;
}

function failure(version: string, hash: string): Record<string, unknown> {
	return {
		schema_version: 1,
		transaction_id: TXN_A,
		success: false,
		phase: "validating_payload",
		message: "InvalidUpdateIdentity",
		identifier: "team.toad.desktop",
		channel: "stable",
		version,
		hash,
	};
}

function success(version: string, hash: string): Record<string, unknown> {
	return { ...failure(version, hash), transaction_id: TXN_B, success: true, phase: "complete" };
}

describe("readFailedUpdate", () => {
	test("reports the failed target the running build never reached", () => {
		const dir = resultDir([{ txn: TXN_A, at: 1000, body: failure("0.2.1", "zzz") }]);
		expect(readFailedUpdate(dir, local)).toEqual({
			version: "0.2.1",
			hash: "zzz",
			phase: "validating_payload",
			reason: "InvalidUpdateIdentity",
		});
	});

	test("a later success ends the story", () => {
		const dir = resultDir([
			{ txn: TXN_A, at: 1000, body: failure("0.2.1", "zzz") },
			{ txn: TXN_B, at: 2000, body: success("0.2.2", "yyy") },
		]);
		expect(readFailedUpdate(dir, local)).toBeNull();
	});

	test("an older success does not hide the newer failure", () => {
		const dir = resultDir([
			{ txn: TXN_B, at: 1000, body: success("0.2.0", "abc123") },
			{ txn: TXN_A, at: 2000, body: failure("0.2.1", "zzz") },
		]);
		expect(readFailedUpdate(dir, local)?.version).toBe("0.2.1");
	});

	test("ignores another channel, a foreign schema, and files that are not results", () => {
		const dir = resultDir([
			{ txn: TXN_A, at: 1000, body: { ...failure("0.2.1", "zzz"), channel: "beta" } },
		]);
		writeFileSync(join(dir, ".electrobun-observed-update-result.json"), "{}");
		expect(readFailedUpdate(dir, local)).toBeNull();
		expect(
			readFailedUpdate(
				resultDir([{ txn: TXN_A, at: 1000, body: { ...failure("0.2.1", "zzz"), schema_version: 2 } }]),
				local,
			),
		).toBeNull();
	});

	test("a failure carrying the running hash is not a build we failed to reach", () => {
		const dir = resultDir([{ txn: TXN_A, at: 1000, body: failure("0.2.0", local.hash) }]);
		expect(readFailedUpdate(dir, local)).toBeNull();
	});

	test("a missing channel root is a no-op", () => {
		expect(readFailedUpdate(join(tmpdir(), "toad-update-absent"), local)).toBeNull();
	});
});

function fakeBridge(overrides: Partial<{
	local: RawLocalInfo;
	info: RawUpdateInfo;
	check: () => Promise<RawUpdateInfo>;
	download: () => Promise<void>;
	apply: () => Promise<void>;
	appDataFolder: string;
}> = {}) {
	let info = overrides.info ?? { ...none };
	let listener: ((entry: { status: string; message: string }) => void) | null = null;
	const bridge: UpdateBridge = {
		getLocalInfo: async () => overrides.local ?? local,
		getUpdateInfo: () => info,
		checkForUpdate: async () => {
			if (overrides.check) {
				info = await overrides.check();
				return info;
			}
			return info;
		},
		downloadUpdate: async () => {
			await overrides.download?.();
			info = { ...info, updateReady: true, updateAvailable: true, version: "0.2.1", hash: "zzz" };
		},
		applyUpdate: async () => {
			await overrides.apply?.();
		},
		onStatusChange: (cb) => {
			listener = cb;
		},
		appDataFolder: async () => {
			if (overrides.appDataFolder) return overrides.appDataFolder;
			throw new Error("unmanaged");
		},
	};
	return { bridge, get listener() { return listener; }, setInfo: (next: RawUpdateInfo) => { info = next; } };
}

describe("createDesktopUpdate", () => {
	test("registers a status listener at construction", () => {
		const fake = fakeBridge();
		createDesktopUpdate(fake.bridge, { busyNames: () => [], publish: () => {} });
		expect(fake.listener).not.toBeNull();
	});

	test("refuses apply while a teammate is working", async () => {
		let applied = false;
		const published: string[] = [];
		const { bridge, setInfo } = fakeBridge({
			apply: async () => {
				applied = true;
			},
		});
		setInfo({ version: "0.2.1", hash: "zzz", updateAvailable: true, updateReady: true, error: "" });
		const update = createDesktopUpdate(bridge, {
			busyNames: () => ["Ada"],
			publish: (status) => published.push(status.phase),
		});
		const status = await update.apply();
		expect(applied).toBe(false);
		expect(status.phase).toBe("blocked");
		expect(status.blockedBy).toEqual(["Ada"]);
		expect(published).toContain("blocked");
	});

	test("refuses apply before a download", async () => {
		let applied = false;
		const { bridge } = fakeBridge({
			apply: async () => {
				applied = true;
			},
		});
		const update = createDesktopUpdate(bridge, { busyNames: () => [], publish: () => {} });
		const status = await update.apply();
		expect(applied).toBe(false);
		expect(status.phase).toBe("error");
		expect(status.message).toContain("Download");
	});

	test("does not fetch on a dev channel", async () => {
		let checked = false;
		const { bridge } = fakeBridge({
			local: { ...local, channel: "dev" },
			check: async () => {
				checked = true;
				return none;
			},
		});
		const update = createDesktopUpdate(bridge, { busyNames: () => [], publish: () => {} });
		const status = await update.check();
		expect(checked).toBe(false);
		expect(status.message).toBe("Dev builds do not update.");
	});

	/**
	 * The InvalidUpdateIdentity incident. Electrobun announces a result file
	 * exactly once, so the relaunch after the one that saw the failure emitted
	 * nothing and reported a virgin `updateInfo` — the desk read as idle and
	 * current while it was neither.
	 */
	test("a failed update outlives the launch that was told about it", async () => {
		const { bridge } = fakeBridge({
			appDataFolder: resultDir([{ txn: TXN_A, at: 1000, body: failure("0.2.1", "zzz") }]),
		});
		const update = createDesktopUpdate(bridge, { busyNames: () => [], publish: () => {} });
		const status = await update.snapshot();
		expect(status.currentVersion).toBe("0.2.0");
		expect(status.failedUpdate).toEqual({
			version: "0.2.1",
			hash: "zzz",
			phase: "validating_payload",
			reason: "InvalidUpdateIdentity",
		});
	});

	test("a desk that has moved on carries no failure", async () => {
		const { bridge } = fakeBridge({
			appDataFolder: resultDir([{ txn: TXN_B, at: 1000, body: success("0.2.0", "abc123") }]),
		});
		const update = createDesktopUpdate(bridge, { busyNames: () => [], publish: () => {} });
		expect((await update.snapshot()).failedUpdate).toBeUndefined();
	});

	test("the failure rides along on a published status too", async () => {
		const published: UpdateStatus[] = [];
		const { bridge } = fakeBridge({
			appDataFolder: resultDir([{ txn: TXN_A, at: 1000, body: failure("0.2.1", "zzz") }]),
		});
		const update = createDesktopUpdate(bridge, {
			busyNames: () => [],
			publish: (status) => published.push(status),
		});
		await update.check();
		expect(published.length).toBeGreaterThan(0);
		for (const status of published) expect(status.failedUpdate?.version).toBe("0.2.1");
	});
});
