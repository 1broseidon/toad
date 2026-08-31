import { childEnv } from "../child-env";
import packageInfo from "../../../package.json" with { type: "json" };
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { McpRuntimeServerConfig } from "../../shared/types";
import { oauthProviderFor } from "../mcp/oauth";

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

type Connection = { client: Client; server: McpRuntimeServerConfig };

/**
 * What happened to one server, as a fact rather than a notice.
 *
 * The warn lines below are for the person watching the transcript; this is for
 * the tool ledger, which has to answer "why is that tool not there" long after
 * the notice has scrolled away. `tools` carries both names because the model
 * only ever sees the mangled one and the server only ever knows its own.
 */
export type McpAttachment = {
	serverId: string;
	serverName: string;
	/** Present when the server connected and listed. */
	tools: Array<{ name: string; toolName: string }>;
	/** Why this server contributed what it did. Never empty. */
	reason: string;
	attached: boolean;
};

export class McpTools {
	private constructor(
		private connections: Connection[],
		private definitions: ToolDefinition[],
		private outcomes: McpAttachment[],
	) {}

	static async connect(
		servers: McpRuntimeServerConfig[],
		notice: (level: "info" | "warn" | "error", text: string) => void,
	): Promise<McpTools> {
		const connections: Connection[] = [];
		const definitions: ToolDefinition[] = [];
		const outcomes: McpAttachment[] = [];
		const taken = new Set<string>();

		// Connected in parallel: one slow server should not hold up the others,
		// and a teammate with three servers should start in one timeout, not three.
		const results = await Promise.all(
			servers.map(async (server) => {
				try {
					return { server, connected: await open(server) };
				} catch (err) {
					const oauth = server.type === "http" && server.auth.mode === "oauth";
					const why = short(err, oauth);
					notice("warn", `Could not connect to MCP server ${server.name}: ${why}`);
					return { server, connected: null, why };
				}
			}),
		);

		for (const result of results) {
			const { server, connected } = result;
			if (!connected) {
				outcomes.push({
					serverId: server.id,
					serverName: server.name,
					tools: [],
					attached: false,
					reason: `the ${server.name} MCP server did not connect: ${result.why}`,
				});
				continue;
			}
			connections.push({ client: connected, server });
			try {
				const { tools } = await connected.listTools();
				const listed: Array<{ name: string; toolName: string }> = [];
				for (const tool of tools) {
					const name = uniqueName(server.name, tool.name, taken);
					definitions.push(wrap(connected, server, tool, name));
					listed.push({ name, toolName: tool.name });
				}
				outcomes.push({
					serverId: server.id,
					serverName: server.name,
					tools: listed,
					attached: true,
					reason: `attached from the ${server.name} MCP server`,
				});
			} catch (err) {
				outcomes.push({
					serverId: server.id,
					serverName: server.name,
					tools: [],
					attached: false,
					reason: `the ${server.name} MCP server connected but would not list its tools: ${short(err)}`,
				});
				notice("warn", `Could not list tools on ${server.name}: ${short(err)}`);
			}
		}

		return new McpTools(connections, definitions, outcomes);
	}

	tools(): ToolDefinition[] {
		return this.definitions;
	}

	/** One row per server Toad was asked to connect, whether or not it worked. */
	attachments(): McpAttachment[] {
		return this.outcomes;
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

/** Which MCP server a tool named in the ledger came from, mangled name and all. */
export function attachmentOwning(
	attachments: readonly McpAttachment[],
	name: string,
): McpAttachment | undefined {
	return attachments.find((entry) => entry.tools.some((tool) => tool.name === name));
}

async function open(server: McpRuntimeServerConfig): Promise<Client> {
	const client = new Client(
		{ name: "Toad", version: packageInfo.version },
		{ versionNegotiation: { mode: "auto" } },
	);
	const oauthProvider = server.type === "http" ? oauthProviderFor(server) : undefined;
	const transport =
		server.type === "stdio"
			? new StdioClientTransport({
					command: server.command,
					args: server.args,
					// Inherited so a server can find node, python and the user's PATH;
					// an app launched from Finder otherwise has almost none of it.
					env: childEnv(server.env),
				})
			: new StreamableHTTPClientTransport(new URL(server.url), {
					requestInit: server.headers ? { headers: server.headers } : undefined,
					authProvider: oauthProvider,
				});

	try {
		await withTimeout(client.connect(transport), CONNECT_TIMEOUT_MS, `${server.name} did not connect`);
		return client;
	} catch (error) {
		// The SDK deliberately makes changed-AS recovery a host decision. Clear
		// only discovery; issuer-bound clients and tokens remain isolated.
		oauthProvider?.invalidateCredentials?.("discovery");
		throw error;
	}
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
	server: McpRuntimeServerConfig,
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

function short(err: unknown, credentialSensitive = false): string {
	if (credentialSensitive) return "authentication or connection failed; reconnect it in Desktop Settings";
	const raw = err instanceof Error ? err.message : String(err);
	const message = raw
		.replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
		.replace(/(access_token|refresh_token|client_secret|code)=([^\s&"']+)/gi, "$1=[redacted]");
	return message.length > 200 ? `${message.slice(0, 200)}…` : message;
}
