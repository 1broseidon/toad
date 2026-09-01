import type { Persona } from "../../shared/types";
import { memberGrant } from "../node/members";
import { localNodeId } from "../store/records";

/**
 * The allow-list, enforced: what a mobile member's wire may see and touch.
 *
 * The grant on a member record names desks. Everything the wire carries is
 * keyed by persona id, and a persona's desk is legible from the id itself —
 * bare ids are this desk's, `nodeId/personaId` is a linked one's. That prefix
 * is the live wire convention (it dies with the envelope, not here), so this
 * module is deliberately the only place the grant meets it: reads are
 * filtered, persona-addressed requests are gated, and pushes are trimmed
 * per socket, all through the same two functions.
 *
 * The grant is read live on every call rather than frozen at session mint,
 * so tightening a phone's access on the owning desk applies to its open
 * socket the moment the record lands here.
 */

/** The desk a persona id belongs to, by the wire's own convention. */
function deskOf(personaId: string): string {
	const cut = personaId.indexOf("/");
	return cut === -1 ? localNodeId() : personaId.slice(0, cut);
}

function maySee(grant: string[], personaId: string): boolean {
	return grant.includes(deskOf(personaId));
}

/** Requests that name a persona, and the param that names it. */
const PERSONA_KEYED: Record<string, "personaId" | "id"> = {
	loadTranscript: "personaId",
	toggleReaction: "personaId",
	setRing: "personaId",
	searchThread: "personaId",
	listChapters: "personaId",
	startFreshChapter: "personaId",
	listPeerThreads: "personaId",
	sendPrompt: "personaId",
	steerPrompt: "personaId",
	cancelTurn: "personaId",
	answerPermission: "personaId",
	startSession: "personaId",
	stopSession: "personaId",
	getSessionInfo: "personaId",
	setModel: "personaId",
	setMode: "personaId",
	setConfig: "personaId",
	composeFace: "personaId",
	saveAttachment: "personaId",
	computerStatus: "personaId",
	computerScreenshot: "personaId",
	computerFrames: "personaId",
	computerVncUrl: "personaId",
	teammateTools: "personaId",
	updatePersona: "id",
	deletePersona: "id",
};

/**
 * Refuses a persona-addressed request aimed outside the grant.
 *
 * Returns the refusal message, or null to let the request through. A missing
 * grant means the membership was revoked while the socket was open — every
 * request refuses, and the close that follows the tombstone lands shortly.
 */
export function memberGate(memberNode: string, method: string, params: unknown): string | null {
	const grant = memberGrant(memberNode);
	if (!grant) return "This phone's membership is no longer active";
	const key = PERSONA_KEYED[method];
	if (!key) return null;
	const target = (params as Record<string, unknown> | null)?.[key];
	if (typeof target !== "string" || target.length === 0) return null;
	return maySee(grant, target) ? null : "That desktop is not shared with this phone";
}

function filterRecord<T>(grant: string[], record: Record<string, T>): Record<string, T> {
	const out: Record<string, T> = {};
	for (const [personaId, value] of Object.entries(record)) {
		if (maySee(grant, personaId)) out[personaId] = value;
	}
	return out;
}

/**
 * Trims a read's answer to the granted desks. Methods that answer in persona
 * ids are trimmed by id; everything else passes through untouched.
 */
export function memberResult(memberNode: string, method: string, result: unknown): unknown {
	const grant = memberGrant(memberNode);
	if (!grant) return result;
	switch (method) {
		case "listPersonas":
			return Array.isArray(result)
				? (result as Persona[]).filter((persona) => maySee(grant, persona.id))
				: result;
		case "listPreviews":
		case "listPeerActivity":
			return result && typeof result === "object" && !Array.isArray(result)
				? filterRecord(grant, result as Record<string, unknown>)
				: result;
		case "listSchedules":
			return Array.isArray(result)
				? result.filter((job) => maySee(grant, String((job as { personaId?: unknown }).personaId ?? "")))
				: result;
		case "searchAllThreads": {
			const body = result as { hits?: Array<{ personaId: string }> } | null;
			if (!body?.hits) return result;
			return { ...body, hits: body.hits.filter((hit) => maySee(grant, hit.personaId)) };
		}
		case "fleetRoster": {
			const body = result as { rosters?: Array<{ node: { id: string } }> } | null;
			if (!body?.rosters) return result;
			return { ...body, rosters: body.rosters.filter((row) => grant.includes(row.node.id)) };
		}
		default:
			return result;
	}
}

/**
 * Trims one push for one member socket.
 *
 * Roster-shaped payloads are filtered; per-persona events are dropped whole
 * when their persona sits outside the grant. Peer-thread events pass — a
 * thread key names two teammates and v1 does not untangle whose desk is
 * whose; the transcript behind it is still gated at the read.
 */
export function memberPush(
	memberNode: string,
	name: string,
	payload: unknown,
): { drop: boolean; payload: unknown } {
	const grant = memberGrant(memberNode);
	if (!grant) return { drop: true, payload };
	switch (name) {
		case "personasChanged":
			return {
				drop: false,
				payload: Array.isArray(payload)
					? (payload as Persona[]).filter((persona) => maySee(grant, persona.id))
					: payload,
			};
		case "peerActivityChanged":
			return {
				drop: false,
				payload:
					payload && typeof payload === "object" && !Array.isArray(payload)
						? filterRecord(grant, payload as Record<string, unknown>)
						: payload,
			};
		case "schedulesChanged":
			return {
				drop: false,
				payload: Array.isArray(payload)
					? payload.filter((job) =>
							maySee(grant, String((job as { personaId?: unknown }).personaId ?? "")),
						)
					: payload,
			};
		case "transcriptAppended":
		case "transcriptUpdated":
		case "streamDelta":
		case "sessionInfoChanged":
		case "faceProgress": {
			const personaId = (payload as { personaId?: unknown } | null)?.personaId;
			if (typeof personaId !== "string") return { drop: false, payload };
			return { drop: !maySee(grant, personaId), payload };
		}
		default:
			return { drop: false, payload };
	}
}
