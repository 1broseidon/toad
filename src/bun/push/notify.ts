import type { SessionInfo, SessionState, TranscriptEvent } from "../../shared/types";
import { getSettings } from "../store/settings";
import { getPersona } from "../store/personas";
import { clearDevicePush, pushTargets } from "../web/devices";
import { sendPush } from "./apns";

/**
 * Which moments are worth a buzz.
 *
 * Everything here rides the supervisor's existing `Broadcast` seam rather
 * than reaching into session code, because every event that would justify a
 * notification already crosses it. That keeps the rule for "what deserves
 * attention" in one readable file instead of scattered through the places
 * where work happens.
 *
 * The judgement this module makes is mostly about *restraint*. A notification
 * is an interruption of someone's actual life, and an agent app generates far
 * more events than a person wants to feel. So: three kinds, each individually
 * switchable, and never about the screen already in your hand.
 */

export type PushKind = "turn-ended" | "permission" | "blocked";

type Dispatch = { kind: PushKind; personaId: string; title: string; body: string };

/**
 * What each connected device is looking at.
 *
 * Per device, not global. `activePersonaId` in index.ts is one variable shared
 * by every client, which is fine for a window title and wrong for this: the
 * desktop having a conversation open says nothing about whether the phone in
 * your pocket should stay quiet.
 */
const viewing = new Map<string, string | null>();

/** Last state seen per teammate, so a transition can be recognised as one. */
const lastState = new Map<string, SessionState>();

/** Pending permission requests already announced, so an update is not a resend. */
const announced = new Set<string>();

export function deviceViewing(deviceId: string, personaId: string | null): void {
	viewing.set(deviceId, personaId);
}

export function forgetDeviceViewing(deviceId: string): void {
	viewing.delete(deviceId);
}

function enabled(kind: PushKind): boolean {
	const push = getSettings().push;
	if (!push?.enabled) return false;
	switch (kind) {
		case "turn-ended":
			return push.turnEnded !== false;
		case "permission":
			return push.permission !== false;
		case "blocked":
			return push.blocked !== false;
	}
}

function teammateName(personaId: string): string {
	return getPersona(personaId)?.name ?? "A teammate";
}

/**
 * Fan out to every registered device except the ones already watching.
 *
 * Failures are swallowed on purpose: a desktop that cannot reach Apple should
 * drop a buzz, never disturb a turn. The one failure that gets acted on is
 * Apple reporting the token dead, which prunes it at the source — the whole
 * feedback loop described in docs/push.md.
 */
async function dispatch({ kind, personaId, title, body }: Dispatch): Promise<void> {
	if (!enabled(kind)) return;
	const targets = pushTargets();
	if (targets.length === 0) return;

	await Promise.all(
		targets.map(async (target) => {
			if (viewing.get(target.id) === personaId) return;
			const result = await sendPush(target.token, target.environment, {
				title,
				body,
				data: { personaId, kind },
				// One row per teammate per kind: a teammate that finishes twice
				// while the phone is locked should read as one interruption.
				threadId: personaId,
				collapseId: `${personaId}:${kind}`,
			});
			if (!result.ok && result.gone) clearDevicePush(target.token);
		}),
	);
}

function fire(payload: Dispatch): void {
	void dispatch(payload).catch(() => {
		/* A missed notification is not worth a log line every turn. */
	});
}

/**
 * A teammate's session changed state.
 *
 * Turn-ended is the `thinking → idle` edge specifically, not arrival at idle:
 * a session that starts idle, or settles back to idle after a cancel, has not
 * finished anything worth reporting. `error` is the blocked case, and is
 * announced from any state, because arriving at error is always news.
 */
export function observeSession(info: SessionInfo): void {
	const previous = lastState.get(info.personaId);
	lastState.set(info.personaId, info.state);
	if (previous === info.state) return;

	if (info.state === "idle" && previous === "thinking") {
		fire({
			kind: "turn-ended",
			personaId: info.personaId,
			title: teammateName(info.personaId),
			body: "Finished — ready when you are.",
		});
		return;
	}
	if (info.state === "error") {
		fire({
			kind: "blocked",
			personaId: info.personaId,
			title: teammateName(info.personaId),
			body: info.error ? trim(info.error) : "Stopped on an error.",
		});
	}
}

/**
 * Something landed in a transcript.
 *
 * Only two things here are interruptions rather than progress: a permission
 * request nobody has answered, and the agent asking a human to do something
 * it cannot. Both are the app saying *it cannot continue without you*, which
 * is the one message a notification is genuinely for.
 */
export function observeTranscript(personaId: string, event: TranscriptEvent): void {
	if (event.kind === "permission") {
		if (event.decision !== undefined) {
			announced.delete(event.requestId);
			return;
		}
		if (announced.has(event.requestId)) return;
		announced.add(event.requestId);
		fire({
			kind: "permission",
			personaId,
			title: `${teammateName(personaId)} needs you`,
			body: trim(event.title),
		});
		return;
	}
	if (event.kind === "human_action" && event.status === "pending") {
		if (announced.has(event.actionId)) return;
		announced.add(event.actionId);
		fire({
			kind: "permission",
			personaId,
			title: `${teammateName(personaId)} needs you`,
			body: trim(event.reason),
		});
	}
}

/** A teammate that is gone should not leave its state behind to transition from. */
export function forgetPersonaState(personaId: string): void {
	lastState.delete(personaId);
}

/** Notification bodies are one line on a lock screen, not a paragraph. */
function trim(text: string): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > 160 ? `${flat.slice(0, 159)}…` : flat;
}
