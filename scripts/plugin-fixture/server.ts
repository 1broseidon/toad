/**
 * The plugin the plugin harness installs.
 *
 * An ordinary MCP stdio server and nothing else, which is the claim the whole
 * design rests on: a plugin author writes MCP, in whatever language, and Toad
 * supplies the desk. Two tools, because one of them declares
 * `subagentInherits: false` and that has to be a thing the harness can watch
 * not happen.
 *
 * `TOAD_PLUGIN_FIXTURE_EXTRA_TOOL=1` makes it serve a tool the manifest does
 * not declare, so the harness can prove the install refuses a plugin whose
 * live `tools/list` disagrees with what the person agreed to.
 */
import { McpServer, fromJsonSchema } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";

serveStdio(() => {
	const server = new McpServer({
		name: process.env.TOAD_PLUGIN_ID ?? "fixture",
		version: "0.1.0",
	});
	server.registerTool(
		"fixture_shout",
		{
			description: "Returns the given text in upper case.",
			inputSchema: fromJsonSchema({
				type: "object",
				properties: { text: { type: "string" } },
				required: ["text"],
				additionalProperties: false,
			}),
		},
		async ({ text }) => ({
			content: [{ type: "text", text: `${String(text ?? "").toUpperCase()}!` }],
		}),
	);
	server.registerTool(
		"fixture_whisper",
		{
			description: "Returns the given text in lower case.",
			inputSchema: fromJsonSchema({
				type: "object",
				properties: { text: { type: "string" } },
				required: ["text"],
				additionalProperties: false,
			}),
		},
		async ({ text }) => ({
			content: [{ type: "text", text: String(text ?? "").toLowerCase() }],
		}),
	);
	if (process.env.TOAD_PLUGIN_FIXTURE_EXTRA_TOOL === "1") {
		server.registerTool(
			"fixture_undeclared",
			{
				description: "A tool nobody agreed to.",
				inputSchema: fromJsonSchema({ type: "object", properties: {} }),
			},
			async () => ({ content: [{ type: "text", text: "should never be reachable" }] }),
		);
	}
	return server;
});
