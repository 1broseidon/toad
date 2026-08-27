/**
 * Repro/regression for the open bug in the computer handoff spec: does an
 * http MCP server survive the session/load (and session/resume) path of the
 * claude ACP adapter, or only session/new?
 *
 * Phase A (control): fresh adapter, session/new with an http server, prompt
 * that requires calling one of its tools. Proven working previously.
 * Phase B: a second adapter process, session/resume-or-load of phase A's
 * session with the same mcpServers list, same prompt.
 *
 * Both phases also sample the spawned claude CLI's argv for `--mcp-config`,
 * which is ground truth independent of model behaviour.
 *
 * Run: TOAD_COMPUTER_URL=http://127.0.0.1:18787 bun scripts/verify-acp-load-mcp.ts
 * Requires the QA computer container (tokenless) from the handoff doc.
 */
import { client, ndJsonStream, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ADAPTER = ["npx", "-y", "@agentclientprotocol/claude-agent-acp@0.70.0"];
const computerUrl = process.env.TOAD_COMPUTER_URL ?? "http://127.0.0.1:18787";
// `headers` must be present and must be an array of {name, value} pairs:
// ACP's zMcpServerHttp requires it, and the adapter's request validation
// (vecSkipError) silently DROPS any entry that fails the schema — which is
// exactly the bug this script guards against.
const MCP_SERVERS = [{ type: "http", name: "Toad-Desktop", url: `${computerUrl}/mcp`, headers: [] }];
const PROMPT =
	"You have an MCP server named Toad-Desktop attached. Call its capture tool " +
	"(use ToolSearch first if the tool is deferred). Then reply with exactly " +
	"TOOLS:YES if the call succeeded, or TOOLS:NO if no Toad-Desktop tools are " +
	"available to you. Do nothing else.";

const cwd = mkdtempSync(join(tmpdir(), "toad-load-repro-"));
const log = (label: string, value?: unknown) =>
	console.log(
		`\x1b[36m${label}\x1b[0m${value === undefined ? "" : ` ${typeof value === "string" ? value : JSON.stringify(value)}`}`,
	);

/** argv of any live claude process mentioning mcp-config — ground truth. */
async function sampleMcpConfig(tag: string): Promise<void> {
	const out = await Bun.$`ps -eo args`.text().catch(() => "");
	const lines = out
		.split("\n")
		.filter((l) => l.includes("mcp-config") && !l.includes("grep"));
	if (lines.length === 0) {
		log(`${tag} --mcp-config`, "no claude child with --mcp-config visible");
		return;
	}
	for (const line of lines) {
		const m = line.match(/--mcp-config\s+(\S+|'[^']*'|"[^"]*")/);
		log(`${tag} --mcp-config`, m ? m[1] : line.slice(0, 400));
		// If it is a file path, show its contents.
		const path = m?.[1]?.replace(/^['"]|['"]$/g, "");
		if (path?.startsWith("/")) {
			const body = await Bun.file(path)
				.text()
				.catch(() => null);
			if (body) log(`${tag} config body`, body.slice(0, 600));
		}
	}
}

type PhaseResult = { sessionId: string; text: string; stopReason: string };

async function withAdapter(
	tag: string,
	fn: (ctx: any, collect: () => string) => Promise<PhaseResult>,
): Promise<PhaseResult> {
	const proc = Bun.spawn(ADAPTER, {
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
			if (text) console.log(`\x1b[31m[${tag} stderr]\x1b[0m ${text.slice(0, 500)}`);
		}
	})();

	let agentText = "";
	const app = client({ name: "toad-load-repro" })
		.onNotification("session/update", ({ params }) => {
			const update = (params as { update?: Record<string, unknown> }).update;
			if (update?.sessionUpdate === "agent_message_chunk") {
				const content = update.content as { type?: string; text?: string } | undefined;
				if (content?.type === "text" && content.text) agentText += content.text;
			}
			if (update?.sessionUpdate === "tool_call") {
				log(`${tag} tool_call`, {
					title: (update as any).title,
					kind: (update as any).kind,
				});
			}
		})
		.onRequest("session/request_permission", async ({ params }) => {
			const p = params as unknown as {
				options: Array<{ optionId: string; kind?: string }>;
				toolCall?: { title?: string };
			};
			log(`${tag} permission`, p.toolCall?.title);
			const allow =
				p.options.find((o) => o.kind === "allow_once") ??
				p.options.find((o) => o.kind?.startsWith("allow")) ??
				p.options[0]!;
			return { outcome: { outcome: "selected" as const, optionId: allow.optionId } };
		})
		.onRequest("fs/read_text_file", async ({ params }) => ({
			content: await Bun.file((params as any).path).text(),
		}))
		.onRequest("fs/write_text_file", async ({ params }) => {
			await Bun.write((params as any).path, (params as any).content);
			return {};
		});

	try {
		let result: PhaseResult | undefined;
		await app.connectWith(
			ndJsonStream(stdin, proc.stdout as ReadableStream<Uint8Array>),
			async (ctx) => {
				result = await fn(ctx, () => agentText);
			},
		);
		return result!;
	} finally {
		proc.kill();
	}
}

const overall = setTimeout(() => {
	console.error("\n\x1b[31mTIMED OUT\x1b[0m");
	process.exit(1);
}, 420_000);

// Preflight: the computer must answer, or both phases are meaningless.
const health = await fetch(`${computerUrl}/health`).then(
	(r) => r.ok,
	() => false,
);
if (!health) {
	console.error(`computer not reachable at ${computerUrl} — start the QA container first`);
	process.exit(1);
}

log("cwd", cwd);

// ---- Phase A: session/new (control) ----
const a = await withAdapter("A", async (ctx, collect) => {
	const init = (await ctx.request("initialize", {
		protocolVersion: PROTOCOL_VERSION,
		clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false },
	})) as Record<string, any>;
	log("A capabilities", init.agentCapabilities);

	const active = await ctx.buildSession({ cwd, mcpServers: MCP_SERVERS } as never).start();
	log("A sessionId", active.sessionId);

	const sample = setTimeout(() => void sampleMcpConfig("A"), 15_000);
	const prompt = (await ctx.request("session/prompt", {
		sessionId: active.sessionId,
		prompt: [{ type: "text", text: PROMPT }],
	})) as Record<string, any>;
	clearTimeout(sample);
	return { sessionId: active.sessionId, text: collect(), stopReason: prompt.stopReason };
});
log("A stopReason", a.stopReason);
log("A agent text", a.text.slice(-300));

// ---- Phase B: fresh process, resume-or-load the same session ----
const b = await withAdapter("B", async (ctx, collect) => {
	const init = (await ctx.request("initialize", {
		protocolVersion: PROTOCOL_VERSION,
		clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false },
	})) as Record<string, any>;
	const caps = init.agentCapabilities ?? {};
	log("B capabilities", caps);

	// Mirror AcpSession.openSession(): resume first if advertised, then load.
	let opened: string | null = null;
	if (caps.resume) {
		try {
			await ctx.request("session/resume", {
				sessionId: a.sessionId,
				cwd,
				mcpServers: MCP_SERVERS,
			});
			opened = "session/resume";
		} catch (err) {
			log("B session/resume failed", err instanceof Error ? err.message : String(err));
		}
	}
	if (!opened && caps.loadSession) {
		await ctx.request("session/load", {
			sessionId: a.sessionId,
			cwd,
			mcpServers: MCP_SERVERS,
		});
		opened = "session/load";
	}
	if (!opened) throw new Error("adapter advertises neither resume nor loadSession");
	log("B opened via", opened);

	const sample = setTimeout(() => void sampleMcpConfig("B"), 15_000);
	const prompt = (await ctx.request("session/prompt", {
		sessionId: a.sessionId,
		prompt: [{ type: "text", text: PROMPT }],
	})) as Record<string, any>;
	clearTimeout(sample);
	return { sessionId: a.sessionId, text: collect(), stopReason: prompt.stopReason };
});
log("B stopReason", b.stopReason);
log("B agent text", b.text.slice(-300));

clearTimeout(overall);
const verdictOf = (t: string) => (t.includes("TOOLS:YES") ? "YES" : t.includes("TOOLS:NO") ? "NO" : "UNCLEAR");
console.log(`\nsession/new  tools reachable: ${verdictOf(a.text)}`);
console.log(`load/resume  tools reachable: ${verdictOf(b.text)}`);
process.exit(verdictOf(a.text) === "YES" && verdictOf(b.text) === "YES" ? 0 : 1);
