import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { McpServerConfig } from "../../shared/types";

/**
 * MCP servers, as tools the built-in agent can call.
 *
 * ACP hands a server list to the backend and lets it do the connecting. pi has
 * no MCP concept at all, so Toad is the client here: it connects, lists the
 * tools, and hands them over as ordinary pi tools.
 *
 * That inversion is worth the trouble. Toad builds the tool array itself, so
 * there is no question of whether supplying servers replaces the agent's own
 * tools — the guessing that `mcp/compat.ts` exists to contain on the ACP side
 * simply has no equivalent here.
 */

const CONNECT_TIMEOUT_MS = 15_000;

/** MCP result content, which is close to pi's but not identical. */
type McpContent = { type?: string; text?: string; [key: string]: unknown };

type Connection = { client: Client; server: McpServerConfig };

export class McpTools {
	private constructor(
		private connections: Connection[],
		private definitions: ToolDefinition[],
	) {}

	static async connect(
		servers: McpServerConfig[],
		notice: (level: "info" | "warn" | "error", text: string) => void,
	): Promise<McpTools> {
		const connections: Connection[] = [];
		const definitions: ToolDefinition[] = [];
		const taken = new Set<string>();

		// Connected in parallel: one slow server should not hold up the others,
		// and a teammate with three servers should start in one timeout, not three.
		const results = await Promise.all(
			servers.map(async (server) => {
				try {
					return { server, connected: await open(server) };
				} catch (err) {
					notice("warn", `Could not connect to MCP server ${server.name}: ${short(err)}`);
					return null;
				}
			}),
		);

		for (const result of results) {
			if (!result) continue;
			const { server, connected } = result;
			connections.push({ client: connected, server });
			try {
				const { tools } = await connected.listTools();
				for (const tool of tools) {
					const name = uniqueName(server.name, tool.name, taken);
					definitions.push(wrap(connected, server, tool, name));
				}
			} catch (err) {
				notice("warn", `Could not list tools on ${server.name}: ${short(err)}`);
			}
		}

		return new McpTools(connections, definitions);
	}

	tools(): ToolDefinition[] {
		return this.definitions;
	}

	/** Server names that contributed at least one tool, for the session notice. */
	summary(): string[] {
		return this.connections.map((connection) => connection.server.name);
	}

	async close(): Promise<void> {
		await Promise.all(
			this.connections.map((connection) => connection.client.close().catch(() => undefined)),
		);
		this.connections = [];
		this.definitions = [];
	}
}

async function open(server: McpServerConfig): Promise<Client> {
	const client = new Client({ name: "Toad", version: "0.1.0" });
	const transport =
		server.type === "stdio"
			? new StdioClientTransport({
					command: server.command,
					args: server.args,
					// Inherited so a server can find node, python and the user's PATH;
					// an app launched from Finder otherwise has almost none of it.
					env: { ...(process.env as Record<string, string>), ...(server.env ?? {}) },
				})
			: new StreamableHTTPClientTransport(new URL(server.url), {
					requestInit: server.headers ? { headers: server.headers } : undefined,
				});

	await withTimeout(client.connect(transport), CONNECT_TIMEOUT_MS, `${server.name} did not connect`);
	return client;
}

/**
 * A tool name that is unique across servers and legal as a tool name.
 *
 * Two servers may both offer `search`, and the model has one namespace, so the
 * server name leads. Anything a provider might reject is replaced rather than
 * dropped, because a mangled-but-present tool is recoverable and a missing one
 * looks like the server is broken.
 */
function uniqueName(serverName: string, toolName: string, taken: Set<string>): string {
	const slug = (value: string) => value.replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
	const base = `${slug(serverName)}__${slug(toolName)}`.slice(0, 60) || "mcp_tool";
	let name = base;
	let suffix = 2;
	while (taken.has(name)) name = `${base}_${suffix++}`;
	taken.add(name);
	return name;
}

function wrap(
	client: Client,
	server: McpServerConfig,
	tool: { name: string; description?: string; inputSchema?: unknown },
	name: string,
): ToolDefinition {
	return defineTool({
		name,
		label: `${server.name}: ${tool.name}`,
		description: tool.description ?? `${tool.name} on the ${server.name} MCP server`,
		// An MCP inputSchema is JSON Schema, and a TypeBox schema is JSON Schema
		// at runtime, so this passes through as-is rather than being rebuilt.
		parameters: (tool.inputSchema ?? { type: "object", properties: {} }) as never,
		execute: async (_toolCallId, params, signal) => {
			const result = (await client.callTool(
				{ name: tool.name, arguments: params as Record<string, unknown> },
				undefined,
				{ signal },
			)) as { content?: McpContent[]; isError?: boolean };

			const content = (result.content ?? []).map((block) =>
				block?.type === "text" && typeof block.text === "string"
					? { type: "text" as const, text: block.text }
					: { type: "text" as const, text: describe(block) },
			);

			if (result.isError) {
				throw new Error(content.map((block) => block.text).join("\n") || "The MCP tool failed");
			}
			return {
				content: content.length > 0 ? content : [{ type: "text" as const, text: "(no output)" }],
				details: {},
			};
		},
	}) as ToolDefinition;
}

/** Non-text MCP content, named rather than dropped so the model knows it came. */
function describe(block: McpContent): string {
	if (block?.type === "image") return "[image returned by the MCP tool]";
	if (block?.type === "resource") return `[resource: ${JSON.stringify(block.resource ?? {})}]`;
	return JSON.stringify(block ?? {});
}

async function withTimeout<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			work,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error(message)), ms);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

function short(err: unknown): string {
	const message = err instanceof Error ? err.message : String(err);
	return message.length > 200 ? `${message.slice(0, 200)}…` : message;
}
