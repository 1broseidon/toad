/**
 * Verifies the assumptions Toad's supervisor makes, against a real ACP agent.
 *
 * Run: bun hack/verify-acp.ts [backendCmd...]
 * Default backend is `cursor-agent acp`.
 */
import { client, ndJsonStream, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const argv = process.argv.slice(2);
const command = argv.length > 0 ? argv : ["cursor-agent", "acp"];
const cwd = mkdtempSync(join(tmpdir(), "toad-verify-"));

const log = (label: string, value?: unknown) =>
	console.log(
		`\x1b[36m${label}\x1b[0m${value === undefined ? "" : ` ${typeof value === "string" ? value : JSON.stringify(value)}`}`,
	);

const proc = Bun.spawn(command, {
	cwd,
	stdin: "pipe",
	stdout: "pipe",
	stderr: "pipe",
	env: { ...process.env },
});

const sink = proc.stdin as import("bun").FileSink;
const stdin = new WritableStream<Uint8Array>({
	write: (chunk) => {
		sink.write(chunk);
		sink.flush();
	},
	close: () => {
		try {
			sink.end();
		} catch {}
	},
});

void (async () => {
	const reader = (proc.stderr as ReadableStream<Uint8Array>).getReader();
	const decoder = new TextDecoder();
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		const text = decoder.decode(value, { stream: true }).trim();
		if (text) console.log(`\x1b[31m[stderr]\x1b[0m ${text}`);
	}
})();

const seenUpdates = new Map<string, number>();

const app = client({ name: "Toad-verify" })
	.onNotification("session/update", ({ params }) => {
		const update = (params as { update?: Record<string, unknown> }).update;
		const kind = String(update?.sessionUpdate ?? "unknown");
		seenUpdates.set(kind, (seenUpdates.get(kind) ?? 0) + 1);
	})
	.onRequest("session/request_permission", async ({ params, requestId }) => {
		const p = params as unknown as {
			options: Array<{ optionId: string; name: string; kind?: string }>;
			toolCall?: { title?: string };
		};
		log("PERMISSION REQUESTED", {
			requestId,
			title: p.toolCall?.title,
			options: p.options.map((o) => `${o.optionId}:${o.kind ?? "?"}`),
		});
		const allow =
			p.options.find((o) => o.kind === "allow_once") ??
			p.options.find((o) => o.kind?.startsWith("allow")) ??
			p.options[0]!;
		return { outcome: { outcome: "selected" as const, optionId: allow.optionId } };
	})
	.onRequest("fs/read_text_file", async ({ params }) => ({
		content: await Bun.file(params.path).text(),
	}))
	.onRequest("fs/write_text_file", async ({ params }) => {
		await Bun.write(params.path, params.content);
		return {};
	});

const timeout = setTimeout(() => {
	console.error("\n\x1b[31mTIMED OUT\x1b[0m");
	proc.kill();
	process.exit(1);
}, 180_000);

try {
	await app.connectWith(ndJsonStream(stdin, proc.stdout as ReadableStream<Uint8Array>), async (ctx) => {
		const init = (await ctx.request("initialize", {
			protocolVersion: PROTOCOL_VERSION,
			clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false },
		})) as Record<string, any>;

		log("agentInfo", init.agentInfo);
		log("agentCapabilities", init.agentCapabilities);

		const active = await ctx.buildSession({ cwd, mcpServers: [] } as never).start();
		const res = active.newSessionResponse as Record<string, any>;
		log("sessionId", active.sessionId);
		log("response keys", Object.keys(res));
		log("models.currentModelId", res.models?.currentModelId);
		log("models count", res.models?.availableModels?.length);
		log("first 3 models", res.models?.availableModels?.slice(0, 3));
		log("modes", res.modes);
		log("configOptions", res.configOptions?.map?.((o: any) => ({ id: o.id, type: o.type })));

		// --- disposition: which method actually works?
		const modelId: string | undefined = res.models?.availableModels?.[1]?.modelId;
		if (modelId) {
			for (const attempt of [
				{ method: "session/set_model", params: { sessionId: active.sessionId, modelId } },
				{
					method: "session/set_config_option",
					params: { sessionId: active.sessionId, optionId: "model", value: modelId },
				},
			]) {
				try {
					const out = await ctx.request(attempt.method, attempt.params);
					log(`OK   ${attempt.method}`, out ?? {});
				} catch (err) {
					log(`FAIL ${attempt.method}`, err instanceof Error ? err.message : String(err));
				}
			}
		}

		const modeId: string | undefined = res.modes?.availableModes?.[0]?.id;
		if (modeId) {
			try {
				await ctx.request("session/set_mode", { sessionId: active.sessionId, modeId });
				log("OK   session/set_mode", modeId);
			} catch (err) {
				log("FAIL session/set_mode", err instanceof Error ? err.message : String(err));
			}
		}

		// --- a real turn that must touch the filesystem
		log("PROMPTING", "create hello.txt containing the word toad");
		const prompt = (await ctx.request("session/prompt", {
			sessionId: active.sessionId,
			prompt: [
				{
					type: "text",
					text: "Create a file called hello.txt in the current directory containing exactly the word: toad. Then tell me you are done.",
				},
			],
		})) as Record<string, any>;

		log("stopReason", prompt.stopReason);
		log("usage", prompt.usage ?? null);
		log("update kinds seen", Object.fromEntries(seenUpdates));

		const wrote = await Bun.file(join(cwd, "hello.txt"))
			.text()
			.catch(() => null);
		log("hello.txt", wrote === null ? "NOT CREATED" : JSON.stringify(wrote));

		// --- does the session survive a reload in a fresh process?
		log("cwd", cwd);
	});
} catch (err) {
	console.error("\x1b[31mCONNECTION ERROR\x1b[0m", err);
} finally {
	clearTimeout(timeout);
	proc.kill();
}
