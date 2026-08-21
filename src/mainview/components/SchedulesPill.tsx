import { useEffect, useRef, useState } from "react";
import type { ScheduledJob } from "../../shared/types";
import { jobLine } from "../useSchedules";
import { CaretIcon } from "./icons";

type Props = {
	jobs: ScheduledJob[];
	onCancel(id: string): void;
};

export function SchedulesPill({ jobs, onCancel }: Props) {
	const [expanded, setExpanded] = useState(false);
	const root = useRef<HTMLSpanElement>(null);
	const looping = jobs.some((job) => job.kind === "loop");

	useEffect(() => {
		if (!expanded) return;
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return;
			event.stopPropagation();
			setExpanded(false);
		};
		const onPointerDown = (event: PointerEvent) => {
			if (!root.current?.contains(event.target as Node)) setExpanded(false);
		};
		window.addEventListener("keydown", onKeyDown, true);
		document.addEventListener("pointerdown", onPointerDown);
		return () => {
			window.removeEventListener("keydown", onKeyDown, true);
			document.removeEventListener("pointerdown", onPointerDown);
		};
	}, [expanded]);

	if (jobs.length === 0) return null;

	return (
		<span ref={root} className="relative inline-flex shrink-0">
			<button
				type="button"
				className="picker"
				aria-haspopup="menu"
				aria-expanded={expanded}
				onClick={() => setExpanded((current) => !current)}
			>
				<span className="picker-text">
					{jobs.length === 1 ? jobs[0]!.kind : `schedule · ${jobs.length}`}
				</span>
				{looping && (
					<span className="h-dot w-dot shrink-0 rounded-pill bg-accent animate-throat" aria-hidden="true" />
				)}
				<CaretIcon className="picker-caret" />
			</button>

			{expanded && (
				<span className="threads-popup" role="menu">
					{jobs.map((job) => (
						<span key={job.id} className="threads-row" role="menuitem">
							<span className="flex items-start gap-xs">
								<span className="min-w-0 flex-1">
									<span className="block truncate text-sm font-medium text-ink-2">{job.prompt}</span>
									<span className="block text-2xs text-ink-3">{jobLine(job)}</span>
								</span>
								<button
									type="button"
									className="btn-ghost shrink-0 !px-xs text-2xs"
									onClick={() => onCancel(job.id)}
								>
									cancel
								</button>
							</span>
						</span>
					))}
				</span>
			)}
		</span>
	);
}
