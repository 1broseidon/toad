import { randomUUID } from "node:crypto";
import { TEAMMATE_MESSAGE_MAX_LENGTH } from "../../shared/peers";
import type { SessionInfo } from "../../shared/types";
import {
	deliverToPeer,
	fleetRosters,
	listFleetPeers,
	parseRemoteTarget,
	readPeerTranscript,
	remoteTargetId,
} from "../fleet/fleet";
import { deskCapabilities } from "../fleet/capabilities";
import { replicaRecentMessages } from "../fleet/replication";
import { peerOnline } from "../fleet/wire";
import { nodeIdentity } from "../node/identity";
import type { ClientMember } from "../node/members";
import { getPersona, listPersonas } from "../store/personas";
import { localNodeId } from "../store/records";
import * as transcript from "../store/transcript";
import type { CallerSeat, DeliverResult } from "../acp/peers";
import { capMessages } from "./bridge";
import type { BridgeErrorCode, Chain } from "./protocol";

/**
 * What an enrolled MCP client can do in the room.
 *
 * The seat is a *social* seat: it can see who is here, say something to one of
 * them and read what has been said. It cannot hop a teammate, touch a
 * credential, write a replica or administer a desk — see task-42's decided
 * section, and `seat.ts` for how one is admitted.
 *
 * These four are the bridge's social subset seen from outside. They are not a
 * second implementation of it: delivery is `PeerSessions.deliver` and
 * `deliverToPeer`, the roster is `fleetRosters`, the transcript budget is
 * `capMessages`, and the result formatting is `formatToadToolOutput`. What is
 * genuinely different is the *scope* — a client answers to a grant of desks
 * rather than to a persona — and the fact that a client blocks for the reply
 * where a teammate is notified of it. Everything else is the same machinery
 * with a different caller in front of it.
 *
 * ATTRIBUTION IS THE POINT. A message from here arrives in the teammate's tape
 * as the client, named with the desk it connected through: "Claude Code @
 * beastie". Never as the operator, never as a teammate. The `client:` caller
 * id keys the standing thread, the label carries the name, and the marker
 * event's `seat` field is what stops the pill reading like a colleague.
 */

/* -------------------------------------------------------------- dependencies
 * The same injection shape `Bridge` takes, and for the same reason: the store
 * and the fleet are module imports, but a live session is owned by index.ts.
 */

type SeatDeps = {
	supervisor: { info(personaId: string): SessionInfo };
	peers: {
		deliver(input: {
			callerId: string;
			targetId: string;
			message: string;
			chain: Chain;
			outside?: { name: string; node: string; seat?: CallerSeat };
		}): Promise<DeliverResult>;
	};
};

let deps: SeatDeps | undefined;

export function initSeatTools(next: SeatDeps): void {
	deps = next;
}

/* --------------------------------------------------------------- the refusal */

export class SeatToolError extends Error {
	constructor(
		readonly code: BridgeErrorCode,
		message: string,
	) {
		super(message);
	}
}

function refuse(code: BridgeErrorCode, message: string): never {
	throw new SeatToolError(code, message);
}

/* ------------------------------------------------------------ the permission
 * One predicate, one call site per tool — the same shape as `selfHopAllowed`.
 */

/**
 * Whether this client seat may act on this teammate.
 *
 * Every seat may reach every teammate on a desk its grant names, today. The
 * grant is already the seat-level seam and it is enforced separately, above
 * this; what task-31 lands is the finer answer — *which* teammates, and what
 * an outside agent may ask of them — and its verdict plugs in here.
 */
export function clientMayReach(
	_seat: ClientMember,
	_target: { personaId: string; nodeId: string },
): boolean {
	return true;
}

/* ------------------------------------------------------------------ the desks */

type Desk = { nodeId: string; name: string; online: boolean; here: boolean };

/**
 * The desks this seat may reach, this one first.
 *
 * Only granted desks appear. A desk left out of the grant is not "offline" to
 * this client, it is not in the room at all — the same thing a phone sees, and
 * the reason a narrowed grant needs no second mechanism to take effect.
 */
function reachableDesks(seat: ClientMember): Desk[] {
	const here = localNodeId();
	const all: Desk[] = [
		{ nodeId: here, name: nodeIdentity().name, online: true, here: true },
		...listFleetPeers().map((peer) => ({
			nodeId: peer.id,
			name: peer.name,
			online: peerOnline(peer.id),
			here: false,
		})),
	];
	return all.filter((desk) => seat.grant.includes(desk.nodeId));
}

/** The desk a target lives on, or a refusal naming why it is not addressable. */
function deskOf(seat: ClientMember, target: string): { desk: Desk; personaId: string } {
	const remote = parseRemoteTarget(target);
	const nodeId = remote?.nodeId ?? localNodeId();
	const desk = reachableDesks(seat).find((candidate) => candidate.nodeId === nodeId);
	if (!desk) {
		refuse(
			"not_found",
			remote
				? `No desk in your grant owns ${target}. Call list_desks to see the desks this seat may reach.`
				: `${target} is not a teammate on any desk in your grant.`,
		);
	}
	return { desk, personaId: remote?.personaId ?? target };
}

/**
 * A desk that is in the grant but not answering.
 *
 * Said before the call rather than discovered by waiting for one: the wire's
 * own failure is a ten-minute timeout, and "the Mac mini's link is down" is a
 * fact this desk already knows and an agent can act on.
 */
function requireLink(desk: Desk): void {
	if (desk.online) return;
	const known = deskCapabilities(desk.nodeId);
	const lastSeen = known?.heardAt
		? ` It was last heard from ${new Date(known.heardAt).toISOString()}.`
		: "";
	refuse(
		"unreachable",
		`The link to the desk "${desk.name}" is down, so nothing there can be reached right now.${lastSeen}`,
	);
}

/* ------------------------------------------------------------------- the tools */

/**
 * The four tools, as the JSON Schema a client actually sees.
 *
 * Written for an agent that is *not* in the room: the descriptions say what a
 * seat is and what it is scoped to, where `TOAD_TOOLS` in `tools.ts` says the
 * same things to a teammate who lives here. Two audiences, so two texts — but
 * the same names and the same arguments, because a client and a teammate are
 * asking the same machinery for the same thing.
 */
export const SEAT_TOOLS = [
	{
		name: "list_teammates",
		description:
			"The Toad teammates you can reach from this seat, across every desk your enrollment grants you. Each entry gives the teammate's id (the target for message_teammate and read_transcript), its name, what it was created to do, which desk it lives on, and whether it is running. Roster metadata only — it does not include anyone's conversation.",
		inputSchema: { type: "object", properties: {}, additionalProperties: false },
	},
	{
		name: "message_teammate",
		description:
			"Send one message to a Toad teammate and wait for their answer, which is this call's result. The teammate is started if it is not running, and long work can take minutes. Your message appears in their conversation attributed to you by name and the desk you connected through — you are not the user and not one of their teammates, and they are told so. Say who you are and what you need in the message itself; they cannot see this conversation.",
		inputSchema: {
			type: "object",
			properties: {
				target: {
					type: "string",
					description: "A teammate id from list_teammates. Teammates on other desks carry a desk-qualified id, which works here unchanged.",
				},
				message: { type: "string", minLength: 1, maxLength: TEAMMATE_MESSAGE_MAX_LENGTH },
			},
			required: ["target", "message"],
			additionalProperties: false,
		},
	},
	{
		name: "read_transcript",
		description:
			"Read the recent messages in a teammate's conversation with its user. Messages only — not its tool calls or its thinking. Read-only. If the teammate's desk is not reachable right now you get this desk's mirror of the conversation instead, marked as such, which may be missing the newest moments.",
		inputSchema: {
			type: "object",
			properties: {
				target: { type: "string", description: "A teammate id from list_teammates" },
				limit: { type: "integer", minimum: 1, maximum: 100, default: 30 },
			},
			required: ["target"],
			additionalProperties: false,
		},
	},
	{
		name: "list_desks",
		description:
			"The desks (machines) of this Toad room that your seat may reach: each desk's name, its platform, whether it is online, and which one you are connected through. A teammate on an offline desk cannot be messaged until that desk's link is back. Desks this seat was not granted do not appear at all.",
		inputSchema: { type: "object", properties: {}, additionalProperties: false },
	},
] as const;

export type SeatToolName = (typeof SEAT_TOOLS)[number]["name"];

/* --------------------------------------------------------------- validation */

function plainObject(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function onlyKeys(value: Record<string, unknown>, keys: string[]): boolean {
	return Object.keys(value).every((key) => keys.includes(key));
}

/**
 * The same hand-written check `validToadToolArgs` runs, for the same reason:
 * the schema above is the contract on the wire, and this is the gate in front
 * of the handlers. It also spares the SDK a JSON Schema validator dependency
 * this tree does not carry.
 */
export function validSeatToolArgs(name: string, value: unknown): value is Record<string, unknown> {
	if (!plainObject(value)) return false;
	switch (name) {
		case "list_teammates":
		case "list_desks":
			return onlyKeys(value, []);
		case "message_teammate":
			return (
				onlyKeys(value, ["target", "message"]) &&
				typeof value.target === "string" &&
				value.target.length > 0 &&
				typeof value.message === "string" &&
				value.message.length >= 1 &&
				value.message.length <= TEAMMATE_MESSAGE_MAX_LENGTH
			);
		case "read_transcript":
			return (
				onlyKeys(value, ["target", "limit"]) &&
				typeof value.target === "string" &&
				value.target.length > 0 &&
				(value.limit === undefined ||
					(Number.isInteger(value.limit) && Number(value.limit) >= 1 && Number(value.limit) <= 100))
			);
		default:
			return false;
	}
}

/* ---------------------------------------------------------------- handlers */

async function listTeammates(seat: ClientMember): Promise<Record<string, unknown>> {
	const desks = reachableDesks(seat);
	const here = desks.find((desk) => desk.here);
	if (!deps) refuse("internal", "The room is not ready to answer that yet.");
	const supervisor = deps.supervisor;
	const local =
		here
			? listPersonas().map((persona) => ({
					personaId: persona.id,
					name: persona.name,
					goal: persona.goal,
					...(persona.team ? { team: persona.team } : {}),
					desk: here.name,
					status: supervisor.info(persona.id).state,
				}))
			: [];
	/* Teammates on the other granted desks, read from replicated records
	 * rather than asked for — the same roster the UI and a teammate see. An
	 * offline desk's members are shown stopped rather than hidden, because a
	 * teammate you cannot reach right now still exists. */
	const granted = new Set(desks.filter((desk) => !desk.here).map((desk) => desk.nodeId));
	const remote = (await fleetRosters())
		.filter((roster) => granted.has(roster.node.id))
		.flatMap((roster) =>
			roster.teammates.map((teammate) => ({
				personaId: remoteTargetId(roster.node.id, teammate.personaId),
				name: teammate.name,
				goal: teammate.goal ?? "",
				...(teammate.team ? { team: teammate.team } : {}),
				desk: roster.node.name,
				status: roster.online ? teammate.state : ("stopped" as const),
			})),
		);
	return { teammates: [...local, ...remote] };
}

function listDesks(seat: ClientMember): Record<string, unknown> {
	return {
		desks: reachableDesks(seat).map((desk) => {
			const info = deskCapabilities(desk.nodeId);
			return {
				name: desk.name,
				nodeId: desk.nodeId,
				online: desk.online,
				...(info ? { platform: info.capabilities.platform } : {}),
				...(!desk.online && info ? { lastHeardAt: info.heardAt } : {}),
				...(desk.here ? { current: true, note: "you connected through this desk" } : {}),
			};
		}),
	};
}

async function messageTeammate(
	seat: ClientMember,
	args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	const target = String(args.target);
	const message = String(args.message);
	const { desk, personaId } = deskOf(seat, target);
	if (!clientMayReach(seat, { personaId, nodeId: desk.nodeId })) {
		refuse("not_found", `This seat may not message ${target}.`);
	}
	requireLink(desk);

	/* The caller as the room will remember it. The id keys the standing thread
	 * and never collides with a persona; the name and the desk are what the
	 * teammate reads. */
	const callerId = `client:${seat.clientId}`;
	const deskName = nodeIdentity().name;

	if (!desk.here) {
		/* The far desk owns its roster, so "no such teammate" is its answer to
		 * give, not this desk's guess from a replica that may be a beat old. */
		const result = await deliverToPeer(desk.nodeId, {
			targetPersonaId: personaId,
			fromPersona: { id: callerId, name: seat.name },
			fromSeat: "client",
			message,
		});
		if (!result.ok) {
			refuse(
				"backend_unavailable",
				result.detail ?? `The desk "${desk.name}" did not answer.`,
			);
		}
		return { from: result.from ?? personaId, reply: result.reply ?? "", desk: desk.name };
	}

	if (!getPersona(personaId)) refuse("not_found", `No teammate here is called ${target}.`);
	if (!deps) refuse("internal", "The room is not ready to deliver messages.");
	const result = await deps.peers.deliver({
		callerId,
		targetId: personaId,
		message,
		/* Depth one, exactly as an inbound fleet delivery: a client seat is an
		 * outside origin, and the teammates it reaches may still talk among
		 * themselves about it before the chain runs out. */
		chain: { id: randomUUID(), depth: 1, path: [] },
		outside: { name: seat.name, node: deskName, seat: "client" },
	});
	if (!result.ok) refuse(result.reason, result.detail);
	return {
		from: result.from,
		reply: result.reply,
		desk: deskName,
		...(result.note ? { note: result.note } : {}),
	};
}

async function readTranscript(
	seat: ClientMember,
	args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	const target = String(args.target);
	const limit = args.limit === undefined ? 30 : Number(args.limit);
	const { desk, personaId } = deskOf(seat, target);
	if (!clientMayReach(seat, { personaId, nodeId: desk.nodeId })) {
		refuse("not_found", `This seat may not read ${target}.`);
	}

	if (!desk.here) {
		const live = desk.online ? await readPeerTranscript(desk.nodeId, personaId, limit) : null;
		if (live) {
			const capped = capMessages(live.messages);
			return {
				personaId: target,
				name: live.name,
				desk: desk.name,
				messages: capped.messages,
				truncated: live.truncated || capped.truncated,
			};
		}
		/* The owning desk is dark; this desk's mirror still remembers. Said as
		 * `replica` because a mirror must not pretend to be a memory — the
		 * newest moments may be missing. */
		const mirrored = replicaRecentMessages(desk.nodeId, personaId, limit);
		if (!mirrored) {
			refuse(
				"unreachable",
				`The link to the desk "${desk.name}" is down and this desk holds no mirror of ${target}.`,
			);
		}
		const capped = capMessages(mirrored.messages);
		return {
			personaId: target,
			name: mirrored.name,
			desk: desk.name,
			messages: capped.messages,
			truncated: capped.truncated,
			replica: true,
		};
	}

	const persona = getPersona(personaId);
	if (!persona) refuse("not_found", `No teammate here is called ${target}.`);
	const { messages, truncated } = transcript.recentMessages(personaId, limit);
	const capped = capMessages(
		messages.map((event) => ({
			from: event.kind === "user" ? "user" : "teammate",
			text: event.text,
			at: event.ts,
		})),
	);
	return {
		personaId: persona.id,
		name: persona.name,
		desk: desk.name,
		messages: capped.messages,
		truncated: truncated || capped.truncated,
	};
}

/**
 * One tool call from one seat.
 *
 * Arguments are already schema-shaped by the time they arrive; this checks
 * them again with `validSeatToolArgs` because the wire is not the only way in
 * and a handler should not have to trust its caller.
 */
export async function callSeatTool(
	seat: ClientMember,
	name: string,
	args: unknown,
): Promise<Record<string, unknown>> {
	if (!validSeatToolArgs(name, args)) {
		refuse("bad_params", `Those arguments are not valid for ${name}.`);
	}
	switch (name) {
		case "list_teammates":
			return listTeammates(seat);
		case "list_desks":
			return listDesks(seat);
		case "message_teammate":
			return messageTeammate(seat, args);
		case "read_transcript":
			return readTranscript(seat, args);
		default:
			return refuse("unknown_method", `There is no tool called ${name}.`);
	}
}
