import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { platform } from "node:os";
import { basename, join } from "node:path";
import {
	THREADS_DIR,
	decodeFileComponent,
	encodeFileComponent,
	ensureLayout,
	threadKey,
	threadMetaPath,
} from "./paths";
import * as threads from "./store/threads";

test("UUID-only managed names stay byte-for-byte unchanged", () => {
	const key = threadKey(randomUUID(), randomUUID());
	expect(basename(threadMetaPath(key))).toBe(`${key}.json`);
});

test("a remote caller's colon key is a portable thread filename", () => {
	const caller = `remote:${randomUUID()}:${randomUUID()}`;
	const target = randomUUID();
	const key = threadKey(caller, target);
	const file = threadMetaPath(key);

	expect(basename(file)).not.toContain(":");
	expect(basename(file)).toContain("%3A");
	threads.ensure(key, caller, target);
	expect(existsSync(file)).toBe(true);
	expect(threads.listAllKeys()).toContain(key);
});

test("the managed component codec covers the Windows forbidden set", () => {
	const logical = 'CON:<bad>|name?*%". ';
	const encoded = encodeFileComponent(logical);
	expect(encoded).not.toMatch(/[<>:\"/\\|?*\u0000-\u001f\u007f]/);
	expect(encoded.endsWith(".")).toBe(false);
	expect(encoded.endsWith(" ")).toBe(false);
	expect(decodeFileComponent(encoded)).toBe(logical);
});

test("a pre-encoding POSIX thread keeps its existing filename", () => {
	if (platform() === "win32") return;
	ensureLayout();
	const caller = `remote:${randomUUID()}:${randomUUID()}`;
	const target = randomUUID();
	const key = threadKey(caller, target);
	const legacy = join(THREADS_DIR, `${key}.json`);
	writeFileSync(
		legacy,
		JSON.stringify({
			version: 1,
			a: [caller, target].sort()[0],
			b: [caller, target].sort()[1],
			sides: { user: caller, agent: target },
			sessions: [],
			createdAt: 1,
			updatedAt: 1,
		}),
	);
	try {
		expect(threadMetaPath(key)).toBe(legacy);
		expect(threads.listAllKeys()).toContain(key);
	} finally {
		rmSync(legacy, { force: true });
	}
});
