import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { SessionInfo, SessionState, TranscriptEvent } from "../../shared/types";
import { updateSettings } from "../store/settings";
import { createPersona } from "../store/personas";
import { resetDesktopPoster, setDesktopPoster } from "./desktop";
import {
	desktopAttentive,
	desktopShown,
	desktopViewing,
	dispatchFromPeer,
	forgetPersonaState,
	observeSession,
	observeTranscript,
	sendTestDesktopNotification,
} from "./notify";

const posted: Array<{ title: string; body: string }> = [];

function info(personaId: string, state: SessionState, error?: string): SessionInfo {
	return {
		personaId,
		state,
		contextRestored: false,
		models: [],
		modes: [],
		configs: [],
		slashCommands: [],
		capabilities: { loadSession: false, resume: false, fork: false, mcpHttp: false, image: false },
		...(error ? { error } : {}),
	};
}

beforeEach(() => {
	posted.length = 0;
	setDesktopPoster((title, body) => {
		posted.push({ title, body });
	});
	desktopShown(true);
	desktopAttentive(false);
	desktopViewing(null);
	updateSettings({ desktop: { enabled: true }, push: { enabled: false } });
});

afterEach(() => {
	resetDesktopPoster();
});

describe("desktop notifications", () => {
	test("a finished turn toasts when the window is not looking", () => {
		const alice = createPersona({ name: "Alice" });
		observeSession(info(alice.id, "thinking"));
		observeSession(info(alice.id, "ready"));
		expect(posted).toEqual([{ title: "Alice", body: "Finished — ready when you are." }]);
		forgetPersonaState(alice.id);
	});

	test("a permission request is the waiting-for-you toast", () => {
		const alice = createPersona({ name: "Alice" });
		observeTranscript(alice.id, {
			kind: "permission",
			id: "e1",
			ts: 1,
			requestId: "req-1",
			title: "Run rm -rf /tmp/scratch",
			options: [],
		} satisfies TranscriptEvent);
		expect(posted).toEqual([{ title: "Alice needs you", body: "Run rm -rf /tmp/scratch" }]);
		forgetPersonaState(alice.id);
	});

	test("a pending hand-to-human card is the same kind of wait", () => {
		const alice = createPersona({ name: "Alice" });
		observeTranscript(alice.id, {
			kind: "human_action",
			id: "e2",
			ts: 1,
			actionId: "act-1",
			reason: "Tap the 2FA prompt",
			status: "pending",
		} satisfies TranscriptEvent);
		expect(posted).toEqual([{ title: "Alice needs you", body: "Tap the 2FA prompt" }]);
		forgetPersonaState(alice.id);
	});

	test("the conversation already in hand stays quiet", () => {
		const alice = createPersona({ name: "Alice" });
		desktopAttentive(true);
		desktopViewing(alice.id);
		observeSession(info(alice.id, "thinking"));
		observeSession(info(alice.id, "ready"));
		expect(posted).toEqual([]);
		forgetPersonaState(alice.id);
	});

	test("a hidden window toasts even for the selected teammate", () => {
		const alice = createPersona({ name: "Alice" });
		desktopAttentive(true);
		desktopViewing(alice.id);
		desktopShown(false);
		observeSession(info(alice.id, "thinking"));
		observeSession(info(alice.id, "ready"));
		expect(posted).toHaveLength(1);
		forgetPersonaState(alice.id);
	});

	test("an unfocused window toasts even for the selected teammate", () => {
		const alice = createPersona({ name: "Alice" });
		desktopShown(true);
		desktopAttentive(false);
		desktopViewing(alice.id);
		observeSession(info(alice.id, "thinking"));
		observeSession(info(alice.id, "ready"));
		expect(posted).toHaveLength(1);
		forgetPersonaState(alice.id);
	});

	test("a turned-off desktop destination stays silent", () => {
		const alice = createPersona({ name: "Alice" });
		updateSettings({ desktop: { enabled: false } });
		observeSession(info(alice.id, "thinking"));
		observeSession(info(alice.id, "ready"));
		expect(posted).toEqual([]);
		forgetPersonaState(alice.id);
	});

	test("a kind switch silences only that kind", () => {
		const alice = createPersona({ name: "Alice" });
		updateSettings({ desktop: { enabled: true, turnEnded: false } });
		observeSession(info(alice.id, "thinking"));
		observeSession(info(alice.id, "ready"));
		expect(posted).toEqual([]);
		observeSession(info(alice.id, "error", "model refused"));
		expect(posted).toEqual([{ title: "Alice", body: "model refused" }]);
		forgetPersonaState(alice.id);
	});

	test("a peer envelope toasts here even without a phone key", async () => {
		const result = await dispatchFromPeer(
			{ id: "peer-1", name: "Other desk" },
			{
				kind: "turn-ended",
				personaId: "remote-alice",
				title: "Alice",
				body: "Finished — ready when you are.",
			},
		);
		expect(result.sent).toBe(false);
		expect(posted).toEqual([{ title: "Alice", body: "Finished — ready when you are." }]);
	});

	test("a peer envelope stays quiet when that remote teammate is in hand", async () => {
		desktopAttentive(true);
		desktopViewing("peer-1/remote-alice");
		await dispatchFromPeer(
			{ id: "peer-1", name: "Other desk" },
			{
				kind: "permission",
				personaId: "remote-alice",
				title: "Alice needs you",
				body: "Approve the tool",
			},
		);
		expect(posted).toEqual([]);
	});

	test("a test toast ignores the attention rule", () => {
		desktopAttentive(true);
		desktopViewing("anyone");
		expect(sendTestDesktopNotification()).toEqual({ sent: true });
		expect(posted).toEqual([{ title: "Toad", body: "Notifications are working." }]);
	});
});
