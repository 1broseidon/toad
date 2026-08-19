import type { Persona } from "../../shared/types";
import { PI_BACKEND_ID } from "../acp/registry";
import { AcpSession } from "../acp/session";
import type { Emitters, SessionOptions, TeammateSession } from "./session";

/**
 * Builds the session for a persona's chosen backend.
 *
 * One place decides which harness a teammate runs on, so `Supervisor` and
 * `PeerSessions` — which differ only in where a conversation is written down —
 * do not each grow their own copy of that decision.
 *
 * The built-in agent is imported on demand rather than at the top of the file.
 * Its SDK is a large module graph, and a roster with no Toad Agent teammate in
 * it should not pay to load one: the cost is real at startup, and it drags the
 * whole dependency tree into any tool that merely wants to supervise an ACP
 * backend.
 */
export async function createTeammateSession(
	persona: Persona,
	emit: Emitters,
	options?: SessionOptions,
): Promise<TeammateSession> {
	if (persona.backendId === PI_BACKEND_ID) {
		const { PiSession } = await import("../pi/session");
		return new PiSession(persona, emit, options);
	}
	return new AcpSession(persona, emit, options);
}
