import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
	Attachment,
	Backend,
	Persona,
	Preview,
	SessionInfo,
	TranscriptEvent,
} from "../shared/types";
import { api, on } from "./rpc";

/**
 * A message that has been started but not sent.
 *
 * Kept per teammate and outside the composer, because the composer is one
 * component reused across every conversation: left to hold its own text, a
 * half-written message to one teammate turns up in the field of the next one
 * you open.
 */
export type Draft = { text: string; attachments: Attachment[] };

const EMPTY_DRAFT: Draft = { text: "", attachments: [] };

/** The newest message in a transcript, ignoring everything that is not speech. */
function lastSpoken(events: TranscriptEvent[]): Preview | null {
	for (let index = events.length - 1; index >= 0; index--) {
		const event = events[index]!;
		if (event.kind === "user" || event.kind === "agent") {
			return { from: event.kind === "user" ? "me" : "them", text: event.text, at: event.ts };
		}
	}
	return null;
}

function idleInfo(personaId: string): SessionInfo {
	return {
		personaId,
		state: "idle",
		contextRestored: false,
		models: [],
		modes: [],
		slashCommands: [],
		capabilities: { loadSession: false, resume: false, fork: false, mcpHttp: false, image: false },
	};
}

export function useToad() {
	const [personas, setPersonas] = useState<Persona[]>([]);
	const [backends, setBackends] = useState<Backend[]>([]);
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [ready, setReady] = useState(false);

	const [transcripts, setTranscripts] = useState<Record<string, TranscriptEvent[]>>({});
	const [sessions, setSessions] = useState<Record<string, SessionInfo>>({});
	/* Read from disk once, for teammates whose transcript is not in memory. A
	 * teammate that then says something is covered by `previews` below, which
	 * prefers what has actually arrived. */
	const [stored, setStored] = useState<Record<string, Preview>>({});
	const [drafts, setDrafts] = useState<Record<string, Draft>>({});

	const loaded = useRef(new Set<string>());
	const autoStarted = useRef(new Set<string>());

	// -- bootstrap ----------------------------------------------------------

	useEffect(() => {
		let cancelled = false;
		void (async () => {
			const [loadedPersonas, loadedBackends, loadedPreviews, lastId] = await Promise.all([
				api.listPersonas(),
				api.listBackends(),
				api.listPreviews(),
				api.getLastPersonaId(),
			]);
			if (cancelled) return;
			setPersonas(loadedPersonas);
			setBackends(loadedBackends);
			setStored(loadedPreviews);
			/* Back to the conversation that was open, the way reopening a messages
			 * app does. The main process has already dropped an id whose teammate is
			 * gone, and the first of the roster is the fallback for a first run. */
			setSelectedId((current) => current ?? lastId ?? loadedPersonas[0]?.id ?? null);
			setReady(true);
		})();
		return () => {
			cancelled = true;
		};
	}, []);

	/* Streaming deltas are ignored here on purpose. The conversation shows a
	 * message when it is finished, the way a messages app does — so the only
	 * thing partial text could drive is the typing dots, and session state
	 * already says when those belong on screen. */
	// -- live wiring --------------------------------------------------------

	useEffect(() => {
		const offAppend = on("transcriptAppended", ({ personaId, event }) => {
			setTranscripts((prev) => {
				const existing = prev[personaId] ?? [];
				if (existing.some((e) => e.id === event.id)) {
					return { ...prev, [personaId]: existing.map((e) => (e.id === event.id ? event : e)) };
				}
				return { ...prev, [personaId]: [...existing, event] };
			});
		});

		const offUpdate = on("transcriptUpdated", ({ personaId, event }) => {
			setTranscripts((prev) => {
				const existing = prev[personaId] ?? [];
				const index = existing.findIndex((e) => e.id === event.id);
				if (index === -1) return { ...prev, [personaId]: [...existing, event] };
				const next = existing.slice();
				next[index] = event;
				return { ...prev, [personaId]: next };
			});
		});

		const offInfo = on("sessionInfoChanged", (info) => {
			setSessions((prev) => ({ ...prev, [info.personaId]: info }));
		});

		return () => {
			offAppend();
			offUpdate();
			offInfo();
		};
	}, []);

	// The window title and the native menus describe whoever is in focus.
	useEffect(() => {
		if (ready) void api.setActivePersona(selectedId);
	}, [ready, selectedId]);

	// -- transcript loading -------------------------------------------------

	useEffect(() => {
		if (!selectedId || loaded.current.has(selectedId)) return;
		loaded.current.add(selectedId);
		void (async () => {
			const [events, info] = await Promise.all([
				api.loadTranscript(selectedId),
				api.getSessionInfo(selectedId),
			]);
			setTranscripts((prev) => ({ ...prev, [selectedId]: events }));
			setSessions((prev) => ({ ...prev, [selectedId]: info }));
		})();
	}, [selectedId]);

	// -- actions ------------------------------------------------------------

	const createPersona = useCallback(async (name: string, backendId?: string) => {
		const persona = await api.createPersona({ name, backendId });
		setPersonas((prev) => [...prev, persona]);
		setSelectedId(persona.id);
		return persona;
	}, []);

	const patchPersona = useCallback(async (id: string, patch: Partial<Persona>) => {
		const persona = await api.updatePersona(id, patch);
		setPersonas((prev) => prev.map((p) => (p.id === id ? persona : p)));
		return persona;
	}, []);

	const removePersona = useCallback(async (id: string) => {
		const { deleted } = await api.deletePersona(id);
		if (!deleted) return false;
		setPersonas((prev) => {
			const next = prev.filter((p) => p.id !== id);
			setSelectedId((current) => (current === id ? next[0]?.id ?? null : current));
			return next;
		});
		loaded.current.delete(id);
		autoStarted.current.delete(id);
		setDrafts((prev) => {
			const { [id]: _gone, ...rest } = prev;
			return rest;
		});
		return true;
	}, []);

	const startSession = useCallback(async (id: string) => {
		setSessions((prev) => ({ ...prev, [id]: { ...(prev[id] ?? idleInfo(id)), state: "starting" } }));
		const info = await api.startSession(id);
		setSessions((prev) => ({ ...prev, [id]: info }));
	}, []);

	const stopSession = useCallback(async (id: string) => {
		await api.stopSession(id);
	}, []);

	/**
	 * A teammate should be there when you look at it, so selecting one warms its
	 * session: the first message never waits on a spawn, and the model and mode
	 * pickers have something to show.
	 *
	 * Only from `idle`. A session the user stopped stays stopped, and a failed
	 * one waits to be retried rather than being restarted in a loop.
	 */
	useEffect(() => {
		if (!selectedId || autoStarted.current.has(selectedId)) return;
		if (sessions[selectedId]?.state !== "idle") return;
		autoStarted.current.add(selectedId);
		void startSession(selectedId);
	}, [selectedId, sessions, startSession]);

	const send = useCallback(
		async (id: string, text: string, attachments: Attachment[] = []) => {
			const info = sessions[id];
			if (!info || info.state === "idle" || info.state === "stopped") {
				await startSession(id);
			}
			setDrafts((prev) => {
				const { [id]: _sent, ...rest } = prev;
				return rest;
			});
			await api.sendPrompt(id, text, attachments.length > 0 ? attachments : undefined);
		},
		[sessions, startSession],
	);

	const setDraft = useCallback((id: string, next: Draft) => {
		setDrafts((prev) => {
			// An emptied draft is not a draft. Dropping it keeps the map to the
			// teammates that actually have something waiting.
			if (!next.text && next.attachments.length === 0) {
				if (!(id in prev)) return prev;
				const { [id]: _empty, ...rest } = prev;
				return rest;
			}
			return { ...prev, [id]: next };
		});
	}, []);

	/**
	 * Adds to whatever is already attached, ignoring anything already there.
	 *
	 * Reads the draft inside the update rather than from a render, because a drop
	 * and a paste can land while an earlier batch is still being written to disk,
	 * and the one that resolves second would otherwise overwrite the first.
	 */
	const addAttachments = useCallback((id: string, added: Attachment[]) => {
		if (added.length === 0) return;
		setDrafts((prev) => {
			const draft = prev[id] ?? EMPTY_DRAFT;
			const seen = new Set(draft.attachments.map((a) => a.path));
			const fresh = added.filter((a) => !seen.has(a.path));
			if (fresh.length === 0) return prev;
			return { ...prev, [id]: { ...draft, attachments: [...draft.attachments, ...fresh] } };
		});
	}, []);

	const selected = useMemo(
		() => personas.find((p) => p.id === selectedId) ?? null,
		[personas, selectedId],
	);

	const selectedInfo = selectedId ? sessions[selectedId] ?? idleInfo(selectedId) : null;

	/* What each teammate last said. Live events win over what was read from disk,
	 * because a running teammate's newest message is in memory before anything
	 * would think to go back to the file for it. */
	const previews = useMemo(() => {
		const merged: Record<string, Preview> = { ...stored };
		for (const [personaId, events] of Object.entries(transcripts)) {
			const said = lastSpoken(events);
			if (said) merged[personaId] = said;
		}
		return merged;
	}, [stored, transcripts]);

	return {
		ready,
		personas,
		backends,
		selected,
		selectedId,
		setSelectedId,
		transcript: selectedId ? transcripts[selectedId] ?? [] : [],
		sessionInfo: selectedInfo,
		sessions,
		previews,
		draft: selectedId ? drafts[selectedId] ?? EMPTY_DRAFT : EMPTY_DRAFT,
		setDraft,
		addAttachments,
		createPersona,
		patchPersona,
		removePersona,
		startSession,
		stopSession,
		send,
		cancel: (id: string) => api.cancelTurn(id),
		answerPermission: (id: string, requestId: string, optionId: string) =>
			api.answerPermission(id, requestId, optionId),
		setModel: async (id: string, modelId: string) => {
			const info = await api.setModel(id, modelId);
			setSessions((prev) => ({ ...prev, [id]: info }));
			setPersonas((prev) => prev.map((p) => (p.id === id ? { ...p, modelId } : p)));
		},
		setMode: async (id: string, modeId: string) => {
			const info = await api.setMode(id, modeId);
			setSessions((prev) => ({ ...prev, [id]: info }));
			setPersonas((prev) => prev.map((p) => (p.id === id ? { ...p, modeId } : p)));
		},
		revealWorkspace: (id: string) => api.revealWorkspace(id),
		pickWorkspace: (from?: string) => api.pickWorkspace(from),
		refreshBackends: async () => setBackends(await api.listBackends(true)),
	};
}

export type Toad = ReturnType<typeof useToad>;
