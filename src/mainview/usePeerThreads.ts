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

export function usePeerThreads(selectedId: string | null) {
	const [threads, setThreads] = useState<PeerThreadSummary[]>([]);
	const [activity, setActivity] = useState<Record<string, PeerActivity>>({});
	const [openKey, setOpenKey] = useState<string | null>(null);
	const [thread, setThread] = useState<PeerThread | null>(null);

	const openKeyRef = useRef<string | null>(null);
	const pending = useRef<TranscriptEvent[]>([]);
	const selectedRef = useRef(selectedId);
	selectedRef.current = selectedId;

	const refreshThreads = useCallback(() => {
		if (!selectedId) {
			setThreads([]);
			return;
		}
		const personaId = selectedId;
		void api.listPeerThreads(personaId).then((next) => {
			if (personaId === selectedRef.current) setThreads(next);
		});
	}, [selectedId]);

	const refreshActivity = useCallback(() => {
		void api.listPeerActivity().then(setActivity);
	}, []);

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

	return { threads, activity, openKey, thread, open, close, answerPermission };
}
