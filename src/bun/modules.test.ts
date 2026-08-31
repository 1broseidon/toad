import { expect, test } from "bun:test";
import { Glob } from "bun";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * One file, one module, one copy of its state.
 *
 * `require()` of a relative module out of an ESM file looks like a lazy alias
 * for an import. It is not. Cottontail — the runtime `hutch run` executes every
 * verify harness under — compiles the target *and its whole transitive import
 * graph* into a second unit with its own module registry, so every module-scope
 * Map, cache, latch and listener list underneath it exists twice in one
 * process. Real Bun loads each file once, which is why this is invisible until
 * a harness runs under `hutch`.
 *
 * That is the shape of the bug this test exists to prevent: transcript
 * catch-up went dark under `hutch run verify:hop` while live appends kept
 * landing, because the replication registry was filled on one copy of
 * `fleet/stream-replication.ts` and asked on another.
 *
 * A cycle does not need `require()` to break it. ESM links cycles happily as
 * long as neither side reaches the other while its module body runs — so
 * import the other module normally and call into it from inside a function.
 * Where a module must genuinely stay out of the graph until first use,
 * `await import()` also keeps one instance. `require()` is the only form that
 * does not.
 */
test("no module in the main process is reached through require()", () => {
	const here = fileURLToPath(new URL(".", import.meta.url));
	const offenders: string[] = [];

	for (const relative of new Glob("**/*.ts").scanSync(here)) {
		if (relative.endsWith(".test.ts")) continue;
		const lines = readFileSync(join(here, relative), "utf8").split("\n");
		for (const [index, line] of lines.entries()) {
			/* `this.require()` and friends are methods, not the loader. */
			if (/(^|[^.\w])require\(\s*["'`]/.test(line)) {
				offenders.push(`src/bun/${relative}:${index + 1}`);
			}
		}
	}

	expect(offenders).toEqual([]);
});
