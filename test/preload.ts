import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Gives the whole test process a throwaway data directory, before anything can
 * resolve the real one.
 *
 * `src/bun/paths.ts` resolves `ROOT` once, at import. Bun runs every test file
 * in a single process, so the first file whose static imports reach that module
 * fixes `ROOT` for all of them — and a file that sets `TOAD_DATA_DIR` in its own
 * body runs far too late. On 2026-08-26 that ordering wrote two fixture
 * personas over a live roster. Setting the override here, in a preload, is the
 * only place that is reliably first.
 */
const root = mkdtempSync(join(tmpdir(), "toad-test-"));
process.env.TOAD_DATA_DIR ??= root;

process.on("exit", () => {
	try {
		rmSync(root, { recursive: true, force: true });
	} catch {
		/* A leftover temp directory is not worth failing a test run over. */
	}
});
