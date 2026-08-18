import { useEffect, useRef, useState } from "react";
import type { PeerThreadSummary } from "../../shared/types";
import { plainOf } from "../messages";
import { CaretIcon } from "./icons";

type Props = {
	threads: PeerThreadSummary[];
	onOpen(threadKey: string): void;
};

export function ThreadsPill({ threads, onOpen }: Props) {
	const [expanded, setExpanded] = useState(false);
	const root = useRef<HTMLSpanElement>(null);
	const waiting = threads.some((thread) => thread.waiting);

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

	if (threads.length === 0) return null;

	return (
		<span ref={root} className="relative inline-flex shrink-0">
			<button
				type="button"
				className="picker"
				aria-haspopup="menu"
				aria-expanded={expanded}
				onClick={() => setExpanded((current) => !current)}
			>
				<span className="picker-text">threads · {threads.length}</span>
				{waiting && (
					<>
						<span className="h-dot w-dot shrink-0 rounded-pill bg-warn animate-throat" aria-hidden="true" />
						<span className="sr-only">permission waiting</span>
					</>
				)}
				<CaretIcon className="picker-caret" />
			</button>

			{expanded && (
				<span className="threads-popup" role="menu">
					{threads.map((thread) => (
						<button
							key={thread.threadKey}
							type="button"
							role="menuitem"
							className="threads-row"
							onClick={() => {
								setExpanded(false);
								onOpen(thread.threadKey);
							}}
						>
							<span className="flex items-center gap-2xs">
								<span className="min-w-0 flex-1 truncate text-sm font-medium text-ink-2">
									{thread.withName}
								</span>
								{thread.waiting && (
									<span
										className="h-dot w-dot shrink-0 rounded-pill bg-warn animate-throat"
										aria-hidden="true"
									/>
								)}
							</span>
							<span className="block truncate text-left text-2xs text-ink-3">
								{thread.preview
									? `${thread.preview.from === "me" ? "you: " : ""}${plainOf(thread.preview.text)}`
									: `${thread.exchanges} message${thread.exchanges === 1 ? "" : "s"}`}
							</span>
						</button>
					))}
				</span>
			)}
		</span>
	);
}
