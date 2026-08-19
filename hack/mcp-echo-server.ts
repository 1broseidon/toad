/**
 * A tiny MCP server, for verifying Toad's MCP client without the network.
 *
 * Speaks stdio, offers one tool, and does nothing else. Used by
 * hack/verify-mcp-servers.ts.
 *
 * Run: bun hack/mcp-echo-server.ts   (expects an MCP client on stdin/stdout)
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const server = new Server(
	{ name: "toad-echo", version: "0.0.1" },
	{ capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
	tools: [
		{
			name: "shout",
			description:
				"Returns the given text in upper case. Use this whenever you are asked to shout something.",
			inputSchema: {
				type: "object",
				properties: { text: { type: "string", description: "The text to shout" } },
				required: ["text"],
				additionalProperties: false,
			},
		},
	],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
	if (request.params.name !== "shout") throw new Error(`Unknown tool ${request.params.name}`);
	const text = String((request.params.arguments as { text?: unknown })?.text ?? "");
	return { content: [{ type: "text", text: `${text.toUpperCase()}!` }] };
});

await server.connect(new StdioServerTransport());
