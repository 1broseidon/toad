import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ThirdPartyNotices } from "../shared/types";

/**
 * The third-party notices this build ships with.
 *
 * Written by `scripts/generate-notices.ts` into `dist/`, copied into the
 * bundle at `notices/third-party.json`. Read from disk rather than imported so
 * ~380 KB of license text stays out of the main process bundle until someone
 * opens the list, and so a build whose generator did not run says so instead
 * of failing to compile.
 */
let cached: ThirdPartyNotices | null | undefined;

function noticesPath(): string | undefined {
	const here = dirname(fileURLToPath(import.meta.url));
	return [
		join(here, "notices", "third-party.json"),
		join(here, "..", "notices", "third-party.json"),
		// Running from source: whatever the generator last wrote.
		join(process.cwd(), "dist", "third-party-notices.json"),
	].find(existsSync);
}

export function thirdPartyNotices(): ThirdPartyNotices | null {
	if (cached !== undefined) return cached;
	const path = noticesPath();
	if (!path) return (cached = null);
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as ThirdPartyNotices;
		cached = parsed.schemaVersion === 1 && Array.isArray(parsed.packages) ? parsed : null;
	} catch {
		cached = null;
	}
	return cached;
}
