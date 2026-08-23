/**
 * A tiny MCP server, for verifying Toad's MCP client without the network.
 *
 * Speaks stdio, offers one tool, and does nothing else. Used by
 * hack/verify-mcp-servers.ts.
 *
 * Run: bun hack/mcp-echo-server.ts   (expects an MCP client on stdin/stdout)
 */
import { McpServer, fromJsonSchema } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";

serveStdio(() => {
	const server = new McpServer({ name: "toad-echo", version: "0.0.1" });
	server.registerTool(
		"shout",
		{
			description: "Returns the given text in upper case. Use this whenever you are asked to shout something.",
			inputSchema: fromJsonSchema({
				type: "object",
				properties: { text: { type: "string", description: "The text to shout" } },
				required: ["text"],
				additionalProperties: false,
			}),
		},
		async ({ text }) => ({
			content: [{ type: "text", text: `${String(text ?? "").toUpperCase()}!` }],
		}),
	);
	return server;
});
