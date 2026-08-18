import { useCallback, useEffect, useRef, useState } from "react";
import type {
	PeerActivity,
	PeerThread,
	PeerThreadSummary,
	TranscriptEvent,
} from "../shared/types";
import { api, on } from "./rpc";

function fold(events: TranscriptEvent[], event: TranscriptEvent): TranscriptEvent[] {
	const index = events.findIndex((existing) => existing.id === event.id);
	if (index === -1) return [...events, event];
	const next = events.slice();
	next[index] = event;
	return next;
}

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

	useEffect(() => {
		let cancelled = false;
		const refresh = () => {
			void api.listPeerActivity().then((next) => {
				if (!cancelled) setActivity(next);
			});
		};
		refresh();
		const off = on("peerActivityChanged", refresh);
		return () => {
			cancelled = true;
			off();
		};
	}, []);

	useEffect(() => {
		let cancelled = false;
		if (!selectedId) {
			setThreads([]);
			return;
		}
		void api.listPeerThreads(selectedId).then((next) => {
			if (!cancelled) setThreads(next);
		});
		return () => {
			cancelled = true;
		};
	}, [selectedId]);

	useEffect(() => {
		const refresh = () => refreshThreads();
		const offAppend = on("peerThreadAppended", refresh);
		const offUpdate = on("peerThreadUpdated", refresh);
		const offActivity = on("peerActivityChanged", refresh);
		return () => {
			offAppend();
			offUpdate();
			offActivity();
		};
	}, [refreshThreads]);

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
