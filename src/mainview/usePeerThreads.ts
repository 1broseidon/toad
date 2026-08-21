import { useCallback, useEffect, useRef, useState } from "react";
import type {
	PeerActivity,
	PeerThread,
	PeerThreadSummary,
	TranscriptEvent,
} from "../shared/types";
import { fold } from "./events";
import { api, on } from "./rpc";

/**
 * How long news of a peer exchange is allowed to pile up before it is fetched.
 *
 * Two agents talking produce a run of events in quick succession, and every one
 * of them moves the same two summaries. Long enough to catch a burst in one
 * refresh, short enough that nobody sees the pill lag behind the conversation.
 */
const BURST_MS = 150;

export function usePeerThreads(selectedId: string | null, ready: boolean) {
	const [threads, setThreads] = useState<PeerThreadSummary[]>([]);
	const [activity, setActivity] = useState<Record<string, PeerActivity>>({});
	const [openKey, setOpenKey] = useState<string | null>(null);
	const [thread, setThread] = useState<PeerThread | null>(null);
	const [seenAt, setSeenAt] = useState<Record<string, number>>({});

	const openKeyRef = useRef<string | null>(null);
	const pending = useRef<TranscriptEvent[]>([]);
	const selectedRef = useRef(selectedId);
	selectedRef.current = selectedId;

	const refreshThreads = useCallback(() => {
		if (!ready || !selectedId) {
			setThreads([]);
			return;
		}
		const personaId = selectedId;
		void api.listPeerThreads(personaId).then((next) => {
			if (personaId === selectedRef.current) setThreads(next);
		});
	}, [ready, selectedId]);

	const refreshActivity = useCallback(() => {
		if (!ready) return;
		void api.listPeerActivity().then(setActivity);
	}, [ready]);

	/* Once, and again whenever the selection changes — `refreshThreads` is
	 * rebuilt with it, and drops a response that arrives after you have moved
	 * on. */
	useEffect(refreshActivity, [refreshActivity]);
	useEffect(refreshThreads, [refreshThreads]);

	/* Everything a peer exchange emits lands here: a message, a change to one,
	 * or a change in what a thread is waiting on. All three move both the
	 * activity dots and the header's thread list — an answered permission
	 * changes `waiting` on a summary — so all three share one handler, and a
	 * run of them collapses into a single pair of reads. */
	useEffect(() => {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const soon = () => {
			if (timer) return;
			timer = setTimeout(() => {
				timer = undefined;
				refreshActivity();
				refreshThreads();
			}, BURST_MS);
		};
		const offAppend = on("peerThreadAppended", soon);
		const offUpdate = on("peerThreadUpdated", soon);
		const offActivity = on("peerActivityChanged", soon);
		return () => {
			clearTimeout(timer);
			offAppend();
			offUpdate();
			offActivity();
		};
	}, [refreshActivity, refreshThreads]);

	useEffect(() => {
		openKeyRef.current = null;
		pending.current = [];
		setOpenKey(null);
		setThread(null);
	}, [selectedId]);

	/**
	 * When this teammate's peer traffic was last looked at, so the header can
	 * say whether any of it is new.
	 *
	 * Marked on arrival rather than left at zero: a week-old exchange is not news
	 * because Toad has just started, and a badge that is lit before you have done
	 * anything teaches you to ignore it. Kept per teammate, so looking at one
	 * roster row does not clear the others, and coming back to a teammate does
	 * not re-announce what you already read.
	 */
	useEffect(() => {
		if (!selectedId) return;
		setSeenAt((current) =>
			current[selectedId] === undefined ? { ...current, [selectedId]: Date.now() } : current,
		);
	}, [selectedId]);

	const markSeen = useCallback(() => {
		if (!selectedId) return;
		setSeenAt((current) => ({ ...current, [selectedId]: Date.now() }));
	}, [selectedId]);

	const open = useCallback((threadKey: string) => {
		openKeyRef.current = threadKey;
		pending.current = [];
		setOpenKey(threadKey);
		setThread(null);
		void api.loadPeerThread(threadKey).then((loaded) => {
			if (openKeyRef.current !== threadKey) return;
			if (!loaded) {
				setThread(null);
				return;
			}
			const events = pending.current.reduce(fold, loaded.events);
			pending.current = [];
			setThread({ ...loaded, events });
		});
	}, []);

	const close = useCallback(() => {
		openKeyRef.current = null;
		pending.current = [];
		setOpenKey(null);
		setThread(null);
	}, []);

	useEffect(() => {
		if (!openKey) return;
		const update = ({ threadKey, event }: { threadKey: string; event: TranscriptEvent }) => {
			if (threadKey !== openKey) return;
			setThread((current) => {
				if (!current) {
					pending.current = fold(pending.current, event);
					return current;
				}
				return { ...current, events: fold(current.events, event) };
			});
		};
		const offAppend = on("peerThreadAppended", update);
		const offUpdate = on("peerThreadUpdated", update);
		return () => {
			offAppend();
			offUpdate();
		};
	}, [openKey]);

	const answerPermission = useCallback((requestId: string, optionId: string) => {
		return api.answerPeerPermission(requestId, optionId);
	}, []);

	return {
		threads,
		activity,
		openKey,
		thread,
		seenAt: (selectedId ? seenAt[selectedId] : undefined) ?? Date.now(),
		markSeen,
		open,
		close,
		answerPermission,
	};
}
