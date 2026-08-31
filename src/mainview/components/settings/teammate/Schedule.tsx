import { useEffect, useState } from "react";
import type { ScheduledJob } from "../../../../shared/types";
import { scheduleName } from "../../../../shared/scheduled";
import { api, on } from "../../../rpc";
import { jobLine } from "../../../useSchedules";
import { Section } from "../../fields";

type Props = { personaId: string };

export function Schedule({ personaId }: Props) {
	const [jobs, setJobs] = useState<ScheduledJob[]>([]);

	useEffect(() => {
		let cancelled = false;
		void api.listSchedules(personaId).then((next) => {
			if (!cancelled) setJobs(next);
		});
		const off = on("schedulesChanged", (all) => {
			setJobs(all.filter((job) => job.personaId === personaId));
		});
		return () => {
			cancelled = true;
			off();
		};
	}, [personaId]);

	const cancel = (id: string) => {
		void api.cancelSchedule(id).then(({ cancelled }) => {
			if (cancelled) setJobs((current) => current.filter((job) => job.id !== id));
		});
	};

	/* The way out of a schedule that went quiet on something the user now wants
	 * to hear about, and the way in for one that never should have talked. The
	 * agent chose the flag when it wrote the job; this is who gets the last
	 * word about it. The list re-publishes on change, so the optimistic update
	 * is only for the tap's own latency. */
	const setQuiet = (id: string, quiet: boolean) => {
		setJobs((current) =>
			current.map((job) => (job.id === id ? { ...job, quiet: quiet || undefined } : job)),
		);
		void api.setScheduleQuiet(id, quiet);
	};

	return (
		<Section
			title="Schedule"
			hint="Work this teammate asked Toad to wake it for. Schedule is once. Loop repeats until you or it cancels. Quiet keeps a job's replies out of the chat — errors and anything needing you still come through."
		>
			{jobs.length === 0 ? (
				<p className="text-xs leading-relaxed text-ink-3">
					Nothing scheduled. A teammate sets this itself with the schedule and loop tools — you
					see it here, and you can cancel it.
				</p>
			) : (
				<ul className="flex flex-col divide-y divide-rule-2 border-y border-rule-2">
					{jobs.map((job) => (
						<li key={job.id} className="flex items-start gap-sm py-sm">
							<div className="min-w-0 flex-1">
								<p className="text-sm text-ink-2">{scheduleName(job)}</p>
								<p className="mt-3xs text-2xs text-ink-3">{jobLine(job)}</p>
								{/* The prompt itself, clamped: this is where a schedule is
								    inspected, and a runner-mode prompt is thousands of
								    characters long. */}
								<p className="mt-3xs line-clamp-3 whitespace-pre-wrap text-2xs leading-relaxed text-ink-3">
									{job.prompt}
								</p>
							</div>
							<div className="flex shrink-0 flex-col items-end gap-xs">
								<label className="flex items-center gap-xs">
									<input
										type="checkbox"
										role="switch"
										checked={job.quiet === true}
										onChange={(event) => setQuiet(job.id, event.target.checked)}
									/>
									<span className="text-sm text-ink">Quiet</span>
								</label>
								<button type="button" className="btn-outline" onClick={() => cancel(job.id)}>
									Cancel
								</button>
							</div>
						</li>
					))}
				</ul>
			)}
		</Section>
	);
}
