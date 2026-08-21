import { useEffect, useState } from "react";
import type { ScheduledJob } from "../../../../shared/types";
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

	return (
		<Section
			title="Schedule"
			hint="Work this teammate asked Toad to wake it for. Schedule is once. Loop repeats until you or it cancels."
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
								<p className="text-sm text-ink-2">{job.prompt}</p>
								<p className="mt-3xs text-2xs text-ink-3">{jobLine(job)}</p>
							</div>
							<button type="button" className="btn-outline shrink-0" onClick={() => cancel(job.id)}>
								Cancel
							</button>
						</li>
					))}
				</ul>
			)}
		</Section>
	);
}
