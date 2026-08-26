import type { SessionInfo, SessionState, TranscriptEvent } from "../../shared/types";
import { getSettings } from "../store/settings";
import { getPersona } from "../store/personas";
import { clearDevicePush, pushTargets, setDevicePush } from "../web/devices";
import type { PushEnvironment, PushPayload, PushResult } from "./apns";
import { pushCredentials } from "./apns";
import { instanceIdentity } from "../web/devices";
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

/** Apple's way of saying "real token, wrong door" rather than "token is dead". */
const WRONG_ENVIRONMENT_REASONS = new Set(["BadDeviceToken", "DeviceTokenNotForTopic"]);

/** The other one. */
function otherEnvironment(environment: PushEnvironment): PushEnvironment {
	return environment === "sandbox" ? "production" : "sandbox";
}

/**
 * Send to one device, correcting the environment when the phone declared the
 * wrong one.
 *
 * A token is only valid against the APNs host it was minted against, and the
 * phone is what reports which that is — except the phone cannot actually know.
 * The answer is decided by the entitlement that signed the binary, which is
 * not askable at runtime, so `src/mainview/push.ts` hardcodes the constant.
 * That constant is right for exactly one kind of build, and a TestFlight or
 * App Store build is the other kind: it says "sandbox" while the binary ships
 * with aps-environment production.
 *
 * apns.ts assumes that mismatch heals itself — "the phone re-registers with
 * the right one on its next launch". It does not, because the phone re-reports
 * the same hardcoded answer: Apple says BadDeviceToken, the token is pruned,
 * the phone registers again on resume, and the loop repeats without ever
 * delivering a notification.
 *
 * So a `gone` verdict that could be a mis-declared environment is retried
 * against the other host before it is believed, and a success there rewrites
 * the device record. One extra round-trip, once per device, and the record is
 * right from then on — including across the dev-build/App-Store-build divide
 * that no single hardcoded constant can span.
 */
async function deliver(
	target: { id: string; token: string; environment: PushEnvironment },
	payload: PushPayload,
): Promise<PushResult> {
	const result = await sendPush(target.token, target.environment, payload);
	if (result.ok || !result.gone || !WRONG_ENVIRONMENT_REASONS.has(result.reason)) return result;
	const corrected = otherEnvironment(target.environment);
	const retry = await sendPush(target.token, corrected, payload);
	if (retry.ok) setDevicePush(target.id, target.token, corrected);
	return retry;
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
async function dispatch({ kind, personaId, title, body }: Dispatch, node?: { id: string }): Promise<void> {
	if (!enabled(kind)) return;
	const targets = pushTargets();
	if (targets.length === 0) return;

	/* Envelopes name their authority. The phone resolves the persona against
	 * its own hub — bare when the authority IS its hub, node-qualified when
	 * not — and every desk capable of sending this event uses the same
	 * collapse id, so two key-holding desktops converge at Apple instead of
	 * needing to elect a notifier. */
	const authority = node?.id ?? instanceIdentity().instanceId;
	const qualified = `${authority}/${personaId}`;

	await Promise.all(
		targets.map(async (target) => {
			const watched = viewing.get(target.id);
			if (watched === personaId || watched === qualified) return;
			const result = await deliver(target, {
				title,
				body,
				data: { personaId, node: authority, kind },
				// One row per teammate per kind: a teammate that finishes twice
				// while the phone is locked should read as one interruption.
				threadId: qualified,
				collapseId: `${qualified}:${kind}`,
			});
			if (!result.ok && result.gone) clearDevicePush(target.token);
		}),
	);
}

/** Whether this desk can put a notification in a pocket at all. */
export function canNotify(): boolean {
	return pushCredentials().configured && pushTargets().length > 0;
}

/**
 * A linked desktop's event, pushed from here. The authority observed its own
 * teammate and could not (or also chose to) buzz; this desk holds the APNs
 * key and the phone pairings, so the buzz goes out from here with the
 * authority's name on the envelope.
 */
export async function dispatchFromPeer(
	node: { id: string; name: string },
	input: { kind: PushKind; personaId: string; title: string; body: string },
): Promise<{ sent: boolean }> {
	if (!canNotify() || !enabled(input.kind)) return { sent: false };
	await dispatch(input, node);
	return { sent: true };
}

function fire(payload: Dispatch): void {
	void dispatch(payload).catch(() => {
		/* A missed notification is not worth a log line every turn. */
	});
	/* The same envelope goes to every linked desktop: whichever of them holds
	 * an APNs key and phone pairings sends it too, and shared collapse ids
	 * make the duplicates one buzz. Dynamic import keeps push and fleet from
	 * needing each other at load. */
	void import("../fleet/fleet")
		.then((fleet) => fleet.forwardNotify(payload))
		.catch(() => {});
}

/**
 * A teammate's session changed state.
 *
 * Turn-ended is any edge out of `thinking` that lands somewhere quiet. A
 * live session finishes a turn as `thinking → ready` — it never touches
 * idle, which is why the first cut of this (idle-only) meant the product's
 * whole reason for existing never actually fired outside the test button.
 * `thinking → idle` stays included for a session that stops as it answers.
 * A cancelled turn takes the same edge and earns the same buzz: the phone
 * cancelled it, so the phone knowing it settled is not a false alarm.
 * `error` is the blocked case, announced from any state, because arriving
 * at error is always news.
 */
export function observeSession(info: SessionInfo): void {
	const previous = lastState.get(info.personaId);
	lastState.set(info.personaId, info.state);
	if (previous === info.state) return;

	if ((info.state === "ready" || info.state === "idle") && previous === "thinking") {
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

/**
 * A push sent because someone asked for one.
 *
 * Deliberately skips everything `dispatch` exists to decide: no kind switch,
 * no "are you already looking at it". A test that quietly declined to send
 * would be worse than no test, and the reason a real push failed is exactly
 * what the person who just installed a key needs to read.
 */
export async function sendTestNotification(): Promise<{
	sent: number;
	failed: { reason: string }[];
}> {
	const targets = pushTargets();
	const failed: { reason: string }[] = [];
	let sent = 0;
	await Promise.all(
		targets.map(async (target) => {
			const result = await deliver(target, {
				title: "Toad",
				body: "Notifications are working.",
				collapseId: "toad:test",
			});
			if (result.ok) {
				sent++;
				return;
			}
			failed.push({ reason: result.reason });
			if (result.gone) clearDevicePush(target.token);
		}),
	);
	return { sent, failed };
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
