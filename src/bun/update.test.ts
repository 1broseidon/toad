import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
	blockedMessage,
	busySessionNames,
	createDesktopUpdate,
	mapRawStatus,
	pruneStaleArchives,
	snapshotFromInfo,
	type RawLocalInfo,
	type RawUpdateInfo,
	type UpdateBridge,
} from "./update";

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
});

function fakeBridge(overrides: Partial<{
	local: RawLocalInfo;
	info: RawUpdateInfo;
	check: () => Promise<RawUpdateInfo>;
	download: () => Promise<void>;
	apply: () => Promise<void>;
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
});
