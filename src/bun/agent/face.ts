import type { Face } from "../../shared/face";
import { composeFallbackFace, faceQuery, parseFace } from "../../shared/face";
import type { Persona } from "../../shared/types";
import { createTeammateSession } from "./create";
import type { Emitters } from "./session";

/**
 * Asks a teammate's own agent to choose its face.
 *
 * This runs in a hidden session — same backend, same workspace, its own
 * emitters — so the exchange never appears in the human transcript and the
 * checkpoint it would leave behind is never saved. The session is spawned,
 * asked one question, and stopped.
 *
 * Whatever happens, a face comes back: an unreachable backend, a garbled
 * answer, or a timeout all land on the deterministic fallback read of the
 * persona text, so creation cannot be blocked by the one flourish in it.
 */

// The webview's RPC gives a request 120s; this leaves room for the spawn.
const ANSWER_MS = 60_000;

export async function composePersonaFace(
	persona: Persona,
	onStage: (stage: "spawning" | "asking") => void,
): Promise<{ face: Face; source: "agent" | "fallback" }> {
	const fallback = () => ({
		face: composeFallbackFace(persona.name, persona.goal),
		source: "fallback" as const,
	});

	// Agent text arrives differently per backend: whole on append, revised on
	// update, or streamed by delta. Keyed by message id and joined at the end,
	// all three roads lead to the same reply.
	const replies = new Map<string, string>();
	const emitters: Emitters = {
		appendEvent: (event) => {
			if (event.kind === "agent") replies.set(event.id, event.text);
		},
		updateEvent: (event) => {
			if (event.kind === "agent") replies.set(event.id, event.text);
		},
		delta: (messageId, kind, text) => {
			if (kind === "agent") replies.set(messageId, (replies.get(messageId) ?? "") + text);
		},
		infoChanged: () => {},
		history: () => [],
		// The compose exchange is not a conversation to come back to.
		sessionCheckpointed: () => {},
	};

	// A view of the persona under a derived id, the way peer sessions do it, so
	// the hidden session cannot collide with the supervisor's bridge scope for
	// the real one. No checkpoints: it must start fresh.
	const view: Persona = { ...persona, id: `${persona.id}#face`, sessionCheckpoints: [] };

	try {
		onStage("spawning");
		const session = await createTeammateSession(view, emitters);
		try {
			const info = await session.start();
			if (info.state !== "ready") return fallback();

			onStage("asking");
			const answered = await Promise.race([
				session.prompt(faceQuery(persona.name, persona.goal)).then(() => true),
				new Promise<false>((resolve) => setTimeout(() => resolve(false), ANSWER_MS)),
			]);
			if (!answered) {
				await session.cancel();
				return fallback();
			}

			const face = parseFace([...replies.values()].join("\n"));
			return face ? { face, source: "agent" } : fallback();
		} finally {
			void session.stop().catch(() => undefined);
		}
	} catch {
		return fallback();
	}
}
