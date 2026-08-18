/**
 * Does session/load actually restore the agent's memory across processes?
 *
 * Toad tells the user whether context was restored or is merely replayed from
 * its own transcript, so this has to be measured rather than assumed.
 *
 * Run: bun hack/verify-restore.ts
 */
import { client, ndJsonStream, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SECRET = "marzipan";
const cwd = mkdtempSync(join(tmpdir(), "toad-restore-"));

type Phase = { sessionId?: string; reply: string };

async function withAgent<T>(run: (ctx: any) => Promise<T>): Promise<T> {
	const proc = Bun.spawn(["cursor-agent", "acp"], {
		cwd,
		stdin: "pipe",
		stdout: "pipe",
		stderr: "ignore",
		env: { ...process.env },
	});
	const sink = proc.stdin as import("bun").FileSink;
	const stdin = new WritableStream<Uint8Array>({
		write: (c) => {
			sink.write(c);
			sink.flush();
		},
		close: () => {
			try {
				sink.end();
			} catch {}
		},
	});

	let reply = "";
	const app = client({ name: "Toad-restore" })
		.onNotification("session/update", ({ params }) => {
			const u = (params as any).update;
			if (u?.sessionUpdate === "agent_message_chunk" && u.content?.type === "text") {
				reply += u.content.text;
			}
		})
		.onRequest("session/request_permission", async ({ params }) => ({
			outcome: { outcome: "selected" as const, optionId: (params as any).options[0].optionId },
		}))
		.onRequest("fs/read_text_file", async ({ params }) => ({
			content: await Bun.file(params.path).text(),
		}))
		.onRequest("fs/write_text_file", async ({ params }) => {
			await Bun.write(params.path, params.content);
			return {};
		});

	let result!: T;
	await app.connectWith(
		ndJsonStream(stdin, proc.stdout as ReadableStream<Uint8Array>),
		async (ctx) => {
			await ctx.request("initialize", {
				protocolVersion: PROTOCOL_VERSION,
				clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false },
			});
			(ctx as any).__getReply = () => reply;
			result = await run(ctx);
		},
	);
	proc.kill();
	return result;
}

// Phase 1: tell the agent a secret in a fresh session.
const first: Phase = await withAgent(async (ctx) => {
	const active = await ctx.buildSession({ cwd, mcpServers: [] }).start();
	await ctx.request("session/prompt", {
		sessionId: active.sessionId,
		prompt: [
			{
				type: "text",
				text: `Remember this word, I will ask for it later: ${SECRET}. Just acknowledge briefly.`,
			},
		],
	});
	return { sessionId: active.sessionId, reply: ctx.__getReply() };
});

console.log(`\x1b[36mphase 1 sessionId\x1b[0m ${first.sessionId}`);
console.log(`\x1b[36mphase 1 reply\x1b[0m ${first.reply.trim().slice(0, 120)}`);

// Phase 2: brand new process, load that session, ask for the secret back.
const second: Phase = await withAgent(async (ctx) => {
	let loaded = false;
	try {
		await ctx.request("session/load", { sessionId: first.sessionId, cwd, mcpServers: [] });
		loaded = true;
	} catch (err) {
		console.log(
			`\x1b[31msession/load failed\x1b[0m ${err instanceof Error ? err.message : String(err)}`,
		);
	}
	console.log(`\x1b[36msession/load succeeded\x1b[0m ${loaded}`);
	if (!loaded) return { reply: "" };

	await ctx.request("session/prompt", {
		sessionId: first.sessionId,
		prompt: [{ type: "text", text: "What word did I ask you to remember? Answer with just the word." }],
	});
	return { reply: ctx.__getReply() };
});

const remembered = second.reply.toLowerCase().includes(SECRET);
console.log(`\x1b[36mphase 2 reply\x1b[0m ${second.reply.trim().slice(0, 200)}`);
console.log(
	remembered
		? `\x1b[32mRESTORE IS REAL — the agent remembered "${SECRET}"\x1b[0m`
		: `\x1b[33mRESTORE IS NOT REAL — the agent did not recall "${SECRET}"\x1b[0m`,
);
