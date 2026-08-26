import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isUp, needsStart } from "../shared/session";
import type {
	Attachment,
	Backend,
	Persona,
	PersonaDraft,
	Preview,
	SessionInfo,
	TranscriptEvent,
} from "../shared/types";
import { fold } from "./events";
import { api, on, onWireRestored } from "./rpc";
import { webClient } from "./platform";
import { readCache, writeCache } from "./cache";

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

/* One array for every conversation that has not loaded yet. A fresh `[]` per
 * render would be a new value each time to anything watching the transcript. */
const NO_EVENTS: TranscriptEvent[] = [];

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

/** Electrobun's webview can mount before the RPC socket will answer. A single
 *  hung request then sits until maxRequestTime (120s), which is the Loading…
 *  that never ends. Short attempts with a pause between them survive that. */
async function waitFor<T>(label: string, run: () => Promise<T>, ms: number): Promise<T> {
	return Promise.race([
		run(),
		new Promise<never>((_, reject) =>
			setTimeout(() => reject(new Error(`${label} timed out`)), ms),
		),
	]);
}

async function loadRoster(): Promise<[Persona[], Record<string, Preview>, string | null]> {
	const deadline = Date.now() + 20_000;
	let delay = 150;
	let last: unknown;
	while (Date.now() < deadline) {
		try {
			return await waitFor(
				"roster",
				() => Promise.all([api.listPersonas(), api.listPreviews(), api.getLastPersonaId()]),
				2_000,
			);
		} catch (error) {
			last = error;
			await new Promise((resolve) => setTimeout(resolve, delay));
			delay = Math.min(delay * 1.5, 800);
		}
	}
	throw last instanceof Error ? last : new Error("Toad did not finish loading");
}

function idleInfo(personaId: string): SessionInfo {
	return {
		personaId,
		state: "idle",
		contextRestored: false,
		models: [],
		modes: [],
		configs: [],
		slashCommands: [],
		capabilities: { loadSession: false, resume: false, fork: false, mcpHttp: false, image: false },
	};
}

/** Insert or replace without duplicating a persona when its push races its RPC response. */
function upsertPersona(current: Persona[], persona: Persona): Persona[] {
	const index = current.findIndex((item) => item.id === persona.id);
	if (index < 0) return [...current, persona];
	const next = [...current];
	next[index] = persona;
	return next;
}

function retainPersonaKeys<T>(current: Record<string, T>, ids: Set<string>): Record<string, T> {
	const entries = Object.entries(current).filter(([id]) => ids.has(id));
	return entries.length === Object.keys(current).length ? current : Object.fromEntries(entries);
}

/**
 * @param cacheId The linked desktop's id on shells that visit more than one —
 * turns on the cold-open cache: last known roster and transcript tails paint
 * immediately, and the wire's answers replace them as they arrive.
 */
export function useToad(cacheId?: string) {
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

	/* A wire that dropped and came back has missed pushes with no replay:
	 * bubbles, tool results, the session settling back to ready. So a restore
	 * refetches everything push-fed here — the guard is cleared so transcripts
	 * load again on sight, and the epoch re-runs the loader for whoever is
	 * open right now. Desktop never sees this; its channel does not drop. */
	const [wireEpoch, setWireEpoch] = useState(0);
	useEffect(
		() =>
			onWireRestored(() => {
				loaded.current.clear();
				setWireEpoch((epoch) => epoch + 1);
			}),
		[],
	);
	useEffect(() => {
		if (wireEpoch === 0) return;
		let cancelled = false;
		void (async () => {
			try {
				const [nextPersonas, nextPreviews] = await Promise.all([
					api.listPersonas(),
					api.listPreviews(),
				]);
				if (cancelled) return;
				setPersonas(nextPersonas);
				setStored(nextPreviews);
			} catch {
				/* The wire that just came back can drop again mid-fetch; the next
				 * restore runs this again. */
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [wireEpoch]);

	// -- bootstrap ----------------------------------------------------------

	/* The cache paints first. `ready` flips immediately so the roster shows
	 * the last known team while loadRoster argues with the wire — including
	 * the case where the desktop is asleep and the wire never answers. The
	 * transcript guard (`loaded`) is deliberately left empty: cached events
	 * render, then the first look at a conversation refetches the truth. */
	useEffect(() => {
		if (!cacheId) return;
		const cached = readCache(cacheId);
		if (!cached) return;
		setPersonas((current) => (current.length ? current : cached.personas));
		setStored((current) => (Object.keys(current).length ? current : cached.previews));
		setTranscripts((current) => ({ ...cached.transcripts, ...current }));
		setSelectedId((current) => current ?? cached.personas[0]?.id ?? null);
		setReady(true);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [cacheId]);

	useEffect(() => {
		let cancelled = false;

		void (async () => {
			try {
				/* Backends are not the roster. listBackends can wait on the ACP
				 * registry; if that sits in this first read, teammates stay behind
				 * Loading… while a catalog fetch is the only thing still moving. */
				const [loadedPersonas, loadedPreviews, lastId] = await loadRoster();
				if (cancelled) return;
				setPersonas(loadedPersonas);
				setStored(loadedPreviews);
				/* Back to the conversation that was open, the way reopening a messages
				 * app does. The main process has already dropped an id whose teammate is
				 * gone, and the first of the roster is the fallback for a first run. */
				setSelectedId((current) => current ?? lastId ?? loadedPersonas[0]?.id ?? null);
			} catch (error) {
				/* A window that says "loading" forever is the worst of the outcomes
				 * here: it cannot be told apart from the main process being slow, so
				 * nobody knows to go looking. Say so and let the empty state show.
				 * The reason goes into the string because the native console
				 * forwarder only relays the first argument. */
				if (!cancelled) {
					const reason = error instanceof Error ? error.message : String(error);
					console.error(`Toad could not load its roster: ${reason}`);
				}
			} finally {
				if (!cancelled) setReady(true);
			}

			try {
				const loadedBackends = await api.listBackends();
				if (!cancelled) setBackends(loadedBackends);
			} catch (error) {
				if (!cancelled) {
					const reason = error instanceof Error ? error.message : String(error);
					console.error(`Toad could not list agent backends: ${reason}`);
				}
			}
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
		const merge = ({ personaId, event }: { personaId: string; event: TranscriptEvent }) => {
			setTranscripts((prev) => ({ ...prev, [personaId]: fold(prev[personaId] ?? NO_EVENTS, event) }));
		};

		const offPersonas = on("personasChanged", (next) => {
			const ids = new Set(next.map((persona) => persona.id));
			setPersonas(next);
			setSelectedId((current) =>
				current && ids.has(current) ? current : (next[0]?.id ?? null),
			);
			for (const id of loaded.current) {
				if (!ids.has(id)) loaded.current.delete(id);
			}
			for (const id of autoStarted.current) {
				if (!ids.has(id)) autoStarted.current.delete(id);
			}
			setTranscripts((current) => retainPersonaKeys(current, ids));
			setSessions((current) => retainPersonaKeys(current, ids));
			setStored((current) => retainPersonaKeys(current, ids));
			setDrafts((current) => retainPersonaKeys(current, ids));
		});
		const offAppend = on("transcriptAppended", merge);
		const offUpdate = on("transcriptUpdated", merge);

		const offInfo = on("sessionInfoChanged", (info) => {
			setSessions((prev) => ({ ...prev, [info.personaId]: info }));
		});

		return () => {
			offPersonas();
			offAppend();
			offUpdate();
			offInfo();
		};
	}, []);

	/* The window title and the native menus describe whoever is in focus —
	 * and on a phone, the desktop's push judgement leans on the same answer.
	 * A conversation on a screen that is off is not being watched, so
	 * backgrounding withdraws the claim (or the buzz for that teammate dies
	 * in the desktop's suppression map for minutes: a suspended socket sends
	 * no FIN, and the wire-close cleanup never runs). Foregrounding and a
	 * restored wire both restate it, because the server forgets on close. */
	useEffect(() => {
		if (!ready) return;
		const announce = () =>
			void api.setActivePersona(
				!webClient() || document.visibilityState === "visible" ? selectedId : null,
			);
		announce();
		if (!webClient()) return;
		document.addEventListener("visibilitychange", announce);
		const offRestore = onWireRestored(announce);
		return () => {
			document.removeEventListener("visibilitychange", announce);
			offRestore();
		};
	}, [ready, selectedId]);

	/* Desktop toasts use a separate attention signal so blur can withdraw
	 * "you are looking" without clearing the window title. Hidden is owned
	 * bun-side (closing hides the window); this covers unfocused / another
	 * Space while the window is still on screen. */
	useEffect(() => {
		if (!ready || webClient()) return;
		const announce = () =>
			void api.setDesktopAttentive(document.visibilityState === "visible" && document.hasFocus());
		announce();
		window.addEventListener("focus", announce);
		window.addEventListener("blur", announce);
		document.addEventListener("visibilitychange", announce);
		return () => {
			window.removeEventListener("focus", announce);
			window.removeEventListener("blur", announce);
			document.removeEventListener("visibilitychange", announce);
		};
	}, [ready]);

	// -- transcript loading -------------------------------------------------

	useEffect(() => {
		if (!selectedId || loaded.current.has(selectedId)) return;
		// Claimed before the request so that selecting away and back mid-flight
		// does not fetch the same conversation twice, and released again if it
		// fails — an id left claimed is a conversation that reads as empty for
		// the rest of the session with no way to ask for it again.
		loaded.current.add(selectedId);
		void (async () => {
			try {
				const [events, info] = await Promise.all([
					api.loadTranscript(selectedId),
					api.getSessionInfo(selectedId),
				]);
				setTranscripts((prev) => ({ ...prev, [selectedId]: events }));
				setSessions((prev) => ({ ...prev, [selectedId]: info }));
			} catch (error) {
				loaded.current.delete(selectedId);
				const reason = error instanceof Error ? error.message : String(error);
				console.error(`Toad could not load the conversation with ${selectedId}: ${reason}`);
			}
		})();
		/* wireEpoch: a restored wire cleared the guard; this re-runs the load
		 * for the conversation on screen without waiting for a reselect. */
	}, [selectedId, wireEpoch]);

	// -- actions ------------------------------------------------------------

	/* Creation no longer selects: the new-teammate screen owns what happens
	 * next (meet the face, then chat or not), and selecting here would start
	 * the conversation behind it. */
	const createPersona = useCallback(async (draft: PersonaDraft) => {
		const persona = await api.createPersona(draft);
		setPersonas((prev) => upsertPersona(prev, persona));
		return persona;
	}, []);

	/* A face chosen after creation reaches the roster through here rather than
	 * a refetch; the bun side has already persisted it. */
	const absorbPersona = useCallback((persona: Persona) => {
		setPersonas((prev) => upsertPersona(prev, persona));
	}, []);

	const patchPersona = useCallback(async (id: string, patch: Partial<Persona>) => {
		const persona = await api.updatePersona(id, patch);
		setPersonas((prev) => upsertPersona(prev, persona));
		return persona;
	}, []);

	/* Persisted a beat after things settle rather than on every fold — a
	 * streaming reply would otherwise serialize the world per bubble. */
	const persistTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
	useEffect(() => {
		if (!cacheId || !ready || personas.length === 0) return;
		clearTimeout(persistTimer.current);
		persistTimer.current = setTimeout(() => {
			writeCache(cacheId, personas, stored, transcripts);
		}, 1_000);
		return () => clearTimeout(persistTimer.current);
	}, [cacheId, ready, personas, stored, transcripts]);

	/* A drag settled: reorder optimistically, tell the desktop the new order,
	 * and if the row crossed into another team's section, that too. */
	const arrangePersonas = useCallback((ids: string[], moved: { id: string; team?: string }) => {
		setPersonas((prev) => {
			const rank = new Map(ids.map((pid, index) => [pid, index]));
			return [...prev]
				.map((persona) =>
					persona.id === moved.id ? { ...persona, team: moved.team ?? "" } : persona,
				)
				.sort(
					(a, b) =>
						(rank.get(a.id) ?? Number.MAX_SAFE_INTEGER) -
						(rank.get(b.id) ?? Number.MAX_SAFE_INTEGER),
				);
		});
		void api.updatePersona(moved.id, { team: moved.team ?? "" }).catch(() => {});
		void api.setPersonaOrder(ids).catch(() => {});
	}, []);

	const removePersona = useCallback(async (id: string, confirmed = false) => {
		const { deleted } = await api.deletePersona(id, confirmed);
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
	 * Switch a teammate to a different ACP backend.
	 *
	 * If a session is running it is stopped first, because the process belongs
	 * to the old backend and has to go. After the persona is patched the
	 * auto-start guard is reset so the ambient-session effect will spin up the
	 * new backend the moment the state lands as `idle`.
	 */
	const switchBackend = useCallback(
		async (id: string, backendId: string) => {
			const info = sessions[id];
			if (info && isUp(info.state)) {
				await stopSession(id);
			}
			const persona = await api.updatePersona(id, { backendId });
			setPersonas((prev) => prev.map((p) => (p.id === id ? persona : p)));
			autoStarted.current.delete(id);
		},
		[sessions, stopSession],
	);

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
		async (id: string, text: string, attachments: Attachment[] = [], replyTo?: string) => {
			const info = sessions[id];
			if (!info || needsStart(info.state)) {
				await startSession(id);
			}
			setDrafts((prev) => {
				const { [id]: _sent, ...rest } = prev;
				return rest;
			});
			await api.sendPrompt(id, text, attachments.length > 0 ? attachments : undefined, replyTo);
		},
		[sessions, startSession],
	);

	/**
	 * A redirect rather than a follow-up: cancels whatever turn is running and
	 * sends this one immediately once that lands. See `send` for everything
	 * else — starting an idle session, clearing the draft — which is identical.
	 */
	const steer = useCallback(
		async (id: string, text: string, attachments: Attachment[] = [], replyTo?: string) => {
			const info = sessions[id];
			if (!info || needsStart(info.state)) {
				await startSession(id);
			}
			setDrafts((prev) => {
				const { [id]: _sent, ...rest } = prev;
				return rest;
			});
			await api.steerPrompt(id, text, attachments.length > 0 ? attachments : undefined, replyTo);
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

	const cancel = useCallback((id: string) => api.cancelTurn(id), []);

	const answerPermission = useCallback(async (id: string, requestId: string, optionId: string) => {
		const { answered } = await api.answerPermission(id, requestId, optionId);
		// A card held across a process restart missed startup reconciliation pushes.
		// Refetch on an explicit stale result so it retires instead of looking inert.
		if (!answered) {
			const events = await api.loadTranscript(id);
			setTranscripts((prev) => ({ ...prev, [id]: events }));
		}
		return answered;
	}, []);

	const setModel = useCallback(async (id: string, modelId: string) => {
		const info = await api.setModel(id, modelId);
		setSessions((prev) => ({ ...prev, [id]: info }));
		setPersonas((prev) => prev.map((p) => (p.id === id ? { ...p, modelId } : p)));
	}, []);

	const setMode = useCallback(async (id: string, modeId: string) => {
		const info = await api.setMode(id, modeId);
		setSessions((prev) => ({ ...prev, [id]: info }));
		setPersonas((prev) => prev.map((p) => (p.id === id ? { ...p, modeId } : p)));
	}, []);

	const setConfig = useCallback(async (id: string, configId: string, value: string) => {
		const info = await api.setConfig(id, configId, value);
		setSessions((prev) => ({ ...prev, [id]: info }));
	}, []);

	const revealWorkspace = useCallback((id: string) => api.revealWorkspace(id), []);

	const pickWorkspace = useCallback((from?: string) => api.pickWorkspace(from), []);

	const refreshBackends = useCallback(async () => {
		setBackends(await api.listBackends(true));
	}, []);

	const selected = useMemo(
		() => personas.find((p) => p.id === selectedId) ?? null,
		[personas, selectedId],
	);

	/* Memoised for the same reason as everything else here: a teammate with no
	 * session yet has no stored info, and building the idle stand-in during
	 * render would hand out a different object every time. */
	const selectedInfo = useMemo(
		() => (selectedId ? (sessions[selectedId] ?? idleInfo(selectedId)) : null),
		[selectedId, sessions],
	);

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

	/**
	 * One object per change, rather than one per render.
	 *
	 * Everything in here is handed to components and read inside effects, so a
	 * fresh object every render makes `[toad]` mean "on every paint" wherever it
	 * appears in a dependency array, and puts a floor under what memoising a
	 * child could ever save.
	 */
	return useMemo(
		() => ({
			ready,
			personas,
			backends,
			selected,
			selectedId,
			setSelectedId,
			transcript: selectedId ? (transcripts[selectedId] ?? NO_EVENTS) : NO_EVENTS,
			sessionInfo: selectedInfo,
			sessions,
			previews,
			draft: selectedId ? (drafts[selectedId] ?? EMPTY_DRAFT) : EMPTY_DRAFT,
			setDraft,
			addAttachments,
			createPersona,
			absorbPersona,
			patchPersona,
			arrangePersonas,
			switchBackend,
			removePersona,
			startSession,
			stopSession,
			send,
			steer,
			cancel,
			answerPermission,
			setModel,
			setMode,
			setConfig,
			revealWorkspace,
			pickWorkspace,
			refreshBackends,
		}),
		[
			ready,
			personas,
			backends,
			selected,
			selectedId,
			transcripts,
			selectedInfo,
			sessions,
			previews,
			drafts,
			setDraft,
			addAttachments,
			createPersona,
			absorbPersona,
			patchPersona,
			switchBackend,
			removePersona,
			startSession,
			stopSession,
			send,
			steer,
			cancel,
			answerPermission,
			setModel,
			setMode,
			setConfig,
			revealWorkspace,
			pickWorkspace,
			refreshBackends,
		],
	);
}

export type Toad = ReturnType<typeof useToad>;
