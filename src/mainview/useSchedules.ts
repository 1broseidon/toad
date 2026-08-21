import { useCallback, useEffect, useMemo, useState } from "react";
import type { ScheduledJob } from "../shared/types";
import { api, on } from "./rpc";

export function useSchedules(ready: boolean) {
	const [jobs, setJobs] = useState<ScheduledJob[]>([]);

	const refresh = useCallback(() => {
		if (!ready) return;
		void api.listSchedules().then(setJobs).catch(() => {});
	}, [ready]);

	useEffect(refresh, [refresh]);

	useEffect(() => on("schedulesChanged", setJobs), []);

	const byPersona = useMemo(() => {
		const grouped: Record<string, ScheduledJob[]> = {};
		for (const job of jobs) {
			(grouped[job.personaId] ??= []).push(job);
		}
		return grouped;
	}, [jobs]);

	const cancel = useCallback(async (id: string) => {
		const { cancelled } = await api.cancelSchedule(id);
		if (cancelled) setJobs((current) => current.filter((job) => job.id !== id));
		return cancelled;
	}, []);

	return { jobs, byPersona, cancel };
}

export function durationText(ms: number): string {
	if (ms < 60_000) return `${Math.round(ms / 1_000)}s`;
	if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
	if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h`;
	return `${Math.round(ms / 86_400_000)}d`;
}

export function nextText(at: number, now = Date.now()): string {
	const delta = at - now;
	if (delta <= 0) return "now";
	if (delta < 60_000) return `in ${Math.max(1, Math.round(delta / 1_000))}s`;
	if (delta < 3_600_000) return `in ${Math.round(delta / 60_000)}m`;
	if (delta < 86_400_000) return `in ${Math.round(delta / 3_600_000)}h`;
	return `in ${Math.round(delta / 86_400_000)}d`;
}

export function jobLine(job: ScheduledJob): string {
	const when = nextText(job.nextAt);
	if (job.kind === "loop" && job.everyMs) return `loop · ${durationText(job.everyMs)} · ${when}`;
	return `once · ${when}`;
}
