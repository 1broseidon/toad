import type { NotifyPrefs, SessionInfo, SessionState, TranscriptEvent } from "../../shared/types";
import type { PushSenderPlan } from "../fleet/push";
import { getSettings } from "../store/settings";
import { getPersona } from "../store/personas";
import {
	correctPushEnvironment,
	pushFanout,
	pushReach,
	reportPushTokenDead,
	type PushTarget,
} from "../store/push";
import { localNodeId } from "../store/records";
import type { PushEnvironment, PushPayload, PushResult } from "./apns";
import { pushKeyHere } from "./apns";
import { instanceIdentity } from "../web/devices";
import { sendPush } from "./apns";
import { showDesktopNotification } from "./desktop";

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
 * switchable, and never about the screen already in your hand — whether that
 * screen is a paired phone or this desktop's own window.
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

/**
 * Whether this desktop's window is a place someone is looking.
 *
 * `shown` is bun-side: closing hides the window rather than quitting, and
 * that hide is the one moment the webview may not fire a visibilitychange.
 * `focused` is the view's report — unfocused, another Space, another app.
 * Either off means the conversation is not in hand, so a toast may fire.
 */
let windowShown = true;
let windowFocused = true;
let desktopWatched: string | null = null;

export function deviceViewing(deviceId: string, personaId: string | null): void {
	viewing.set(deviceId, personaId);
}

export function desktopShown(shown: boolean): void {
	windowShown = shown;
}

export function desktopAttentive(focused: boolean): void {
	windowFocused = focused;
}

export function desktopViewing(personaId: string | null): void {
	desktopWatched = personaId;
}

export function forgetDeviceViewing(deviceId: string): void {
	viewing.delete(deviceId);
}

function prefsOn(prefs: NotifyPrefs | undefined, kind: PushKind, masterDefault: boolean): boolean {
	if ((prefs?.enabled ?? masterDefault) === false) return false;
	switch (kind) {
		case "turn-ended":
			return prefs?.turnEnded !== false;
		case "permission":
			return prefs?.permission !== false;
		case "blocked":
			return prefs?.blocked !== false;
	}
}

function phoneEnabled(kind: PushKind): boolean {
	return prefsOn(getSettings().push, kind, false);
}

function desktopEnabled(kind: PushKind): boolean {
	return prefsOn(getSettings().desktop, kind, true);
}

function lookingAt(personaId: string, nodeId?: string): boolean {
	if (!windowShown || !windowFocused) return false;
	if (desktopWatched === personaId) return true;
	return nodeId !== undefined && desktopWatched === `${nodeId}/${personaId}`;
}

function deliverDesktop(payload: Dispatch, node?: { id: string }): void {
	if (!desktopEnabled(payload.kind)) return;
	if (lookingAt(payload.personaId, node?.id)) return;
	showDesktopNotification(payload.title, payload.body);
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
async function deliver(target: PushTarget, payload: PushPayload): Promise<PushResult> {
	const result = await sendPush(target.token, target.environment, payload);
	if (result.ok || !result.gone || !WRONG_ENVIRONMENT_REASONS.has(result.reason)) return result;
	const corrected = otherEnvironment(target.environment);
	const retry = await sendPush(target.token, corrected, payload);
	// Only the owning desk may rewrite the record; on any other desk the
	// correction is simply known here and re-learned on the next send, which
	// costs one round-trip per event rather than a fact this desk may not write.
	if (retry.ok) correctPushEnvironment(target.registrationId, corrected);
	return retry;
}

/**
 * Apple says this address is finished.
 *
 * Not a local cleanup any more: a token pruned only where it was observed would
 * leave every other desk buzzing a phone that is gone. `store/push.ts` publishes
 * the fact when this desk owns the registration and reports it upstream when it
 * does not — and names the generation either way, so a report that crosses paths
 * with the phone's next launch cannot kill the token that replaced it.
 */
function prune(target: PushTarget): void {
	reportPushTokenDead(target.registrationId, target.generation);
}

function teammateName(personaId: string): string {
	return getPersona(personaId)?.name ?? "A teammate";
}

/**
 * Whether this desk is the one asked to post to a given phone.
 *
 * A plan is the room's answer, decided once by the desk the event happened on
 * (`electPushSenders`), and a desk obeys it even when it believes it could do
 * better — believing otherwise is exactly the second opinion that turns one
 * event into two buzzes. A registration the plan does not mention is one the
 * elector either could not see or could not place a sender for, and posting to
 * it anyway would be that same second opinion wearing a different hat.
 *
 * No plan at all means nobody is taking turns: a room of one desk, a test send,
 * or an envelope from a build that predates election. Send everything, which is
 * what this desk did before there was anyone to share the room with.
 */
function sendsHere(target: PushTarget, plan: PushSenderPlan | undefined): boolean {
	if (!plan) return true;
	return plan[target.registrationId] === localNodeId();
}

/**
 * Fan out to the devices this desk was elected for, except the ones already
 * watching. Answers how many it actually posted to.
 *
 * Failures are swallowed on purpose: a desktop that cannot reach Apple should
 * drop a buzz, never disturb a turn. The one failure that gets acted on is
 * Apple reporting the token dead, which prunes it at the source — the whole
 * feedback loop described in docs/push.md.
 */
async function dispatch(
	{ kind, personaId, title, body }: Dispatch,
	node?: { id: string },
	plan?: PushSenderPlan,
): Promise<number> {
	const targets = pushFanout().filter((target) => sendsHere(target, plan));
	if (targets.length === 0) return 0;

	/* Envelopes name their authority. The phone resolves the persona against
	 * its own hub — bare when the authority IS its hub, node-qualified when
	 * not. The collapse id stays shared even now that one desk is elected: a
	 * room mid-upgrade still has desks that send without being asked, and one
	 * banner is a better answer for them than two. */
	const authority = node?.id ?? instanceIdentity().instanceId;
	const qualified = `${authority}/${personaId}`;

	let sent = 0;
	await Promise.all(
		targets.map(async (target) => {
			/* What the phone is looking at is reported over its own socket, which
			 * it has with exactly one desk — the desk that owns the registration.
			 * Election puts that desk first whenever it is up, so in the ordinary
			 * case the check is being made by the one desk that can make it. The
			 * gap is a takeover: a stand-in buzzes a phone whose screen may
			 * already be on that teammate, because the owner it would have asked
			 * is the desk that is down. Closing it exactly needs the phone's
			 * attention to replicate, which is a surface of its own. */
			const watched = viewing.get(target.registrationId);
			if (watched === personaId || watched === qualified) return;
			sent++;
			const result = await deliver(target, {
				title,
				body,
				data: { personaId, node: authority, kind },
				// One row per teammate per kind: a teammate that finishes twice
				// while the phone is locked should read as one interruption.
				threadId: qualified,
				collapseId: `${qualified}:${kind}`,
			});
			if (!result.ok && result.gone) prune(target);
		}),
	);
	return sent;
}

/**
 * Whether this desk can put a notification in a pocket at all.
 *
 * Both halves are asked structurally — a signing key it holds material for, an
 * address it holds material for — because this runs on every event a peer
 * forwards and neither question needs anything decrypted to answer.
 */
export function canNotify(): boolean {
	return pushKeyHere() && pushReach() > 0;
}

/**
 * A linked desktop's event, arriving here.
 *
 * Two halves that answer to different owners. The **toast** is about this
 * screen, so this desktop's own preference and attention decide it, exactly as
 * before. The **phone** half is not about this desk at all: the authority
 * already decided that this moment deserves an interruption and already decided
 * which desk delivers it, so a plan-bearing envelope is a job, not a proposal.
 * Asking this desk's phone preference again would mean the same event buzzes or
 * does not depending on which machine happened to be awake — the timing
 * dependence election exists to remove. An envelope with no plan comes from a
 * build that predates all of this, and gets the old rule.
 */
export async function dispatchFromPeer(
	node: { id: string; name: string },
	input: {
		kind: PushKind;
		personaId: string;
		title: string;
		body: string;
		plan?: PushSenderPlan;
	},
): Promise<{ sent: boolean }> {
	deliverDesktop(input, node);
	if (!canNotify()) return { sent: false };
	if (!input.plan && !phoneEnabled(input.kind)) return { sent: false };
	return { sent: (await dispatch(input, node, input.plan)) > 0 };
}

function fire(payload: Dispatch): void {
	deliverDesktop(payload);
	void reachPhones(payload).catch(() => {
		/* A missed notification is not worth a log line every turn. */
	});
}

/**
 * The phone half of a local event: elect once, then tell the room.
 *
 * This desk is the authority, so this desk's preference is what decides whether
 * a pocket should buzz at all — an empty plan is that decision, said in the one
 * word every desk understands. The envelope still goes to *every* linked
 * desktop regardless, because their toasts are theirs to show; only the phone
 * job inside it is addressed to one desk.
 */
async function reachPhones(payload: Dispatch): Promise<void> {
	let plan: PushSenderPlan | undefined = {};
	if (phoneEnabled(payload.kind)) {
		try {
			/* Dynamic so push and fleet do not need each other at load. */
			const { electPushSenders } = await import("../fleet/push");
			plan = electPushSenders();
		} catch {
			/* No fleet to load is no room to elect within, so this desk falls back
			 * to "send what you hold" — the room-of-one rule, and this desk is the
			 * only one that could have sent anyway. */
			plan = undefined;
		}
	}
	await Promise.all([
		dispatch(payload, undefined, plan),
		import("../fleet/fleet")
			.then((fleet) => fleet.forwardNotify({ ...payload, plan }))
			.catch(() => {}),
	]);
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
	const targets = pushFanout();
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
			if (result.gone) prune(target);
		}),
	);
	return { sent, failed };
}

/**
 * A toast sent because someone asked for one. Skips the attention check for
 * the same reason the phone test skips the kind switches: a test that
 * quietly declined would be worse than no test.
 */
export function sendTestDesktopNotification(): { sent: boolean } {
	return { sent: showDesktopNotification("Toad", "Notifications are working.") };
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
