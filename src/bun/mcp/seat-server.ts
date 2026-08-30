import {
	McpServer,
	bearerAuthChallengeResponse,
	createMcpHandler,
	fromJsonSchema,
	requireBearerAuth,
	type AuthInfo,
	type JsonSchemaType,
	type JsonSchemaValidator,
	type McpHttpHandler,
	type StandardSchemaWithJSON,
} from "@modelcontextprotocol/server";
import { ensureRoom } from "../node/room";
import { nodeIdentity } from "../node/identity";
import type { ClientMember } from "../node/members";
import { formatToadToolError, formatToadToolOutput } from "./tools";
import { SEAT_SCOPE, clientForToken, clientTokenVerifier } from "./seat";
import { SEAT_TOOLS, callSeatTool, validSeatToolArgs } from "./seat-tools";

/**
 * The MCP endpoint an enrolled client talks to.
 *
 * `seat.ts` is the authorization-server half — how an outside agent becomes a
 * member of this room. This is the resource-server half: the same four tools
 * `seat-tools.ts` defines, served over streamable HTTP at `/mcp` on the room's
 * TLS door, to whoever presents a live access token for a seat.
 *
 * STATELESS, ON PURPOSE. `createMcpHandler` builds a fresh server instance per
 * request, so there is no session to lose when a desk restarts and nothing to
 * pin a client to one desk. That matches what a seat already is: the
 * membership is a replicated record and the token is this desk's own, so a
 * client whose desk goes dark re-presents its client secret to another desk in
 * its grant and carries on. A session id would have been a fifth thing to
 * revoke.
 *
 * THE SEAT COMES FROM THE TOKEN, NEVER FROM THE BODY. `requireBearerAuth`
 * verifies against `clientTokenVerifier` before the handler is reached, and
 * the per-request factory closes over the member that token names. No tool
 * takes a "who am I" argument, so no request can claim to be a seat it is not.
 */

/** The room's own identity on the wire, so a client can see what it joined. */
function serverInfo(): { name: string; title: string; version: string } {
	const room = ensureRoom();
	return {
		name: "toad",
		title: `${room.name} — ${nodeIdentity().name}`,
		version: process.env.npm_package_version ?? "0",
	};
}

/**
 * The JSON Schema above, wrapped for the SDK, validated by our own gate.
 *
 * The SDK's default validator is Ajv, which this tree does not depend on and
 * has no reason to start depending on for four object schemas. `getValidator`
 * is the documented extension point; `validSeatToolArgs` is the same
 * hand-written check the teammate tools already use, so one function decides
 * what a valid call is on both paths.
 */
function schemaFor(tool: { name: string; inputSchema: unknown }): StandardSchemaWithJSON {
	return fromJsonSchema(tool.inputSchema as JsonSchemaType, {
		getValidator<T>(): JsonSchemaValidator<T> {
			return (input: unknown) =>
				validSeatToolArgs(tool.name, input)
					? { valid: true, data: input as T, errorMessage: undefined }
					: {
							valid: false,
							data: undefined,
							errorMessage: `Those arguments are not valid for ${tool.name}.`,
						};
		},
	});
}

/**
 * A server instance for one request, with the four tools bound to one seat.
 *
 * A refusal comes back as an `isError` tool result rather than a protocol
 * error, in the same words `formatToadToolError` gives a teammate: "the desk
 * is unreachable" is something the calling agent should read and act on, not a
 * transport fault. Successes go through `formatToadToolOutput`, so a quoted
 * transcript arrives fenced for a client exactly as it does for a teammate.
 */
function serverFor(seat: ClientMember): McpServer {
	const server = new McpServer(serverInfo(), {
		capabilities: { tools: {} },
		instructions:
			`You are connected to ${ensureRoom().name}, a Toad room, as an outside agent holding a client seat. ` +
			"You are not one of its teammates and you are not its user: anything you send is attributed to you by name and by the desk you came in through. " +
			"Start with list_teammates to see who is here and which desk each one is on.",
	});
	for (const tool of SEAT_TOOLS) {
		server.registerTool(
			tool.name,
			{ description: tool.description, inputSchema: schemaFor(tool) },
			async (args: unknown) => {
				try {
					const result = await callSeatTool(seat, tool.name, args);
					return { content: [{ type: "text" as const, text: formatToadToolOutput(tool.name, result) }] };
				} catch (error) {
					return {
						content: [{ type: "text" as const, text: formatToadToolError(error) }],
						isError: true,
					};
				}
			},
		);
	}
	return server;
}

let handler: McpHttpHandler | undefined;

function mcpHandler(): McpHttpHandler {
	if (handler) return handler;
	handler = createMcpHandler(
		(context) => {
			const seat = seatOfAuth(context.authInfo);
			if (!seat) {
				/* Unreachable through the HTTP door — the bearer gate runs first
				 * and refuses. Kept as a throw rather than an empty server so a
				 * future caller that forgets the gate fails loudly. */
				throw new Error("The client seat behind this request could not be resolved");
			}
			return serverFor(seat);
		},
		{
			/* Native era is 2026-07-28; 2025-era traffic is served statelessly
			 * from the same factory, which is the SDK's default and is kept
			 * deliberately. Every shipping MCP client still opens with the 2025
			 * handshake unless told otherwise, and there is nothing for the old
			 * era to get wrong here: this endpoint has no session, so the 2025
			 * session operations it would lack (GET, DELETE) are exactly the
			 * ones the stateless fallback already answers 405. Rejecting would
			 * have bought strictness at the price of the feature working. */
			legacy: "stateless",
			onerror: (error) => console.error(`MCP seat: ${error.message}`),
		},
	);
	return handler;
}

/** The member a verified token names, re-read so a revocation lands at once. */
function seatOfAuth(auth: AuthInfo | undefined): ClientMember | null {
	return auth ? clientForToken(auth.token) : null;
}

const gate = requireBearerAuth({
	verifier: clientTokenVerifier,
	requiredScopes: [SEAT_SCOPE],
});

/**
 * One HTTP request to `/mcp`.
 *
 * The `resource_metadata` challenge is built here rather than passed to the
 * gate's options because the room's TLS origin is not knowable at module load
 * — the door may not be open yet, and a phone may have turned web access on
 * since. `origin` is what the web server already resolved for this door.
 */
export async function handleSeatMcpRequest(request: Request, origin: string): Promise<Response> {
	const resourceMetadataUrl = `${origin}/.well-known/oauth-protected-resource/mcp`;
	let auth: AuthInfo | Response;
	try {
		auth = await gate(request);
	} catch (error) {
		return bearerAuthChallengeResponse(error, { resourceMetadataUrl });
	}
	if (auth instanceof Response) {
		/* The gate's own refusal, re-issued with the discovery pointer so a
		 * client that arrived without a token learns where to enroll. */
		return new Response(auth.body, {
			status: auth.status,
			headers: withChallenge(auth.headers, resourceMetadataUrl),
		});
	}
	return mcpHandler().fetch(request, { authInfo: auth });
}

function withChallenge(headers: Headers, resourceMetadataUrl: string): Headers {
	const next = new Headers(headers);
	const existing = next.get("www-authenticate");
	if (existing && !existing.includes("resource_metadata")) {
		next.set("www-authenticate", `${existing}, resource_metadata="${resourceMetadataUrl}"`);
	}
	return next;
}
