/**
 * A plugin that says exactly what it is told to say.
 *
 * `scripts/plugin-fixture` is a plugin behaving; this one is the harness's hand
 * inside a plugin. `probe_bridge` forwards one raw frame down the SDK's bridge
 * connection and hands the answer back verbatim, which is the only way to ask
 * the questions that matter about the transport from where a plugin actually
 * stands:
 *
 * - does `plugin.log.append` do anything at all with an `ownerNode` field a
 *   plugin author added by hopeful analogy with `plugin.log.read`? It must not:
 *   writing another desk's mirror is meant to have no expressible shape, and
 *   "the field is ignored" is a claim about the running code, not the docs.
 * - does a method a plugin was not granted refuse by name, from out here?
 *
 * It owns one log, `notes`, which nothing folds. That is deliberate: a log with
 * no reader is the right place to prove a write went where it went.
 */
import { McpServer, fromJsonSchema } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { ToadBridge } from "../../plugins/toad-plugin-sdk/bridge";

let bridge: ToadBridge | null = null;
/** Resolved once; every tool call waits on it rather than racing the connect. */
const door: Promise<ToadBridge | null> = ToadBridge.connect()
	.then((open) => {
		bridge = open;
		return open;
	})
	.catch(() => null);

serveStdio(() => {
	const server = new McpServer({
		name: process.env.TOAD_PLUGIN_ID ?? "probe",
		version: "0.1.0",
	});
	server.registerTool(
		"probe_bridge",
		{
			description: "Send one raw frame on this plugin's Toad bridge connection.",
			inputSchema: fromJsonSchema({
				type: "object",
				properties: { method: { type: "string" }, params: { type: "object" } },
				required: ["method"],
				additionalProperties: false,
			}),
		},
		async (raw) => {
			const { method, params } = (raw ?? {}) as {
				method: string;
				params?: Record<string, unknown>;
			};
			await door;
			const answer = await send(String(method), params ?? {});
			return { content: [{ type: "text" as const, text: JSON.stringify(answer) }] };
		},
	);
	return server;
});

/** The answer, refusal and all — a refusal is the interesting result here. */
async function send(
	method: string,
	params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	if (!bridge) return { ok: false, code: "no_bridge", error: "this plugin has no bridge" };
	try {
		return { ok: true, result: await bridge.call(method, params) };
	} catch (error) {
		return {
			ok: false,
			code: (error as { code?: string }).code ?? "internal",
			error: (error as Error).message,
		};
	}
}
