import type { PeerThreadSummary } from "../../shared/types";
import { plainOf } from "../messages";
import { webClient } from "../platform";
import { Toolbar } from "./Toolbar";

type Props = {
	threads: PeerThreadSummary[];
	/** The thread currently laid over this list, if any. */
	openKey: string | null;
	/**
	 * Whether a thread is open on top. The sheet underneath keeps its state but
	 * stops dimming the window, because the one above it already does.
	 */
	covered: boolean;
	seenAt: number;
	onSelect(threadKey: string): void;
	onClose(): void;
};

/**
 * A teammate's side conversations, listed down the right-hand side.
 *
 * A drawer rather than the menu this used to be: these are conversations, and a
 * menu of conversations makes you dismiss it to read one and re-open it to read
 * the next. Here the list stays where it is and the thread opens over it, so
 * moving between two threads is one click each rather than three.
 *
 * It takes the right-hand side because that is where the thread itself opens.
 * The roster is on the left and answers "who", so putting "what they have been
 * saying to each other" on the same edge would make the two compete.
 */
export function ThreadsDrawer({
	threads,
	openKey,
	covered,
	seenAt,
	onSelect,
	onClose,
}: Props) {
	return (
		<div
			/* Below the header band, not over it: the control that opens this is up
			   there, it shows whether the list is open, and it is how you close it. */
			className="absolute inset-x-0 bottom-0 top-toolbar z-overlay flex justify-end"
			role="dialog"
			aria-label="Threads"
		>
			{!covered && (
				<button
					type="button"
					className="sheet-scrim animate-fade-in"
					aria-label="Close threads"
					onClick={onClose}
				/>
			)}
			<section className="threads-drawer animate-slide-in-right">
				{/* Sheet grammar on the phone, window grammar on the desk — the
				    same split the thread viewer makes, so the pair feel related. */}
				{webClient() ? (
					<header className="peer-head">
						<h2 className="peer-title">Threads</h2>
						<button type="button" className="peer-done" onClick={onClose}>
							Done
						</button>
					</header>
				) : (
					/* No ✕ on the desk: Escape closes this, so does pressing the
					   conversation behind it, and so does the button in the header that
					   opened it — three ways out already, none of which is a fourth
					   glyph in the title bar. */
					<Toolbar as="header" className="gap-xs border-b border-rule px-gutter">
						<h2 className="min-w-0 flex-1 truncate text-sm font-medium text-ink">Threads</h2>
					</Toolbar>
				)}

				<div className="min-h-0 flex-1 overflow-y-auto py-2xs">
					{threads.length === 0 && (
						<p className="px-sm py-xs text-xs text-ink-3">
							Nothing yet. Threads appear when this teammate talks to another one.
						</p>
					)}
					{threads.map((thread) => (
						<button
							key={thread.threadKey}
							type="button"
							className="threads-row"
							aria-current={thread.threadKey === openKey}
							onClick={() => onSelect(thread.threadKey)}
						>
							<span className="flex items-center gap-2xs">
								<span className="min-w-0 flex-1 truncate text-sm font-medium text-ink-2">
									{thread.withName}
								</span>
								{thread.waiting ? (
									<span
										className="h-dot w-dot shrink-0 rounded-pill bg-warn animate-throat"
										aria-hidden="true"
									/>
								) : (
									thread.lastAt > seenAt && (
										<span className="h-dot w-dot shrink-0 rounded-pill bg-accent" aria-hidden="true" />
									)
								)}
								<span className="shrink-0 text-2xs text-ink-3">{stamp(thread.lastAt)}</span>
							</span>
							<span className="block truncate text-left text-2xs text-ink-3">
								{thread.preview
									? `${thread.preview.fromName}: ${plainOf(thread.preview.text)}`
									: `${thread.exchanges} message${thread.exchanges === 1 ? "" : "s"}`}
							</span>
						</button>
					))}
				</div>
			</section>
		</div>
	);
}

const clock = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const day = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });

/* The clock while it is still today, the date once it is not. A row is scanned
 * for which thread this is, so the stamp is the smallest thing that separates
 * this afternoon from last week. */
function stamp(at: number): string {
	const when = new Date(at);
	const today = new Date();
	const sameDay =
		when.getFullYear() === today.getFullYear() &&
		when.getMonth() === today.getMonth() &&
		when.getDate() === today.getDate();
	return sameDay ? clock.format(when) : day.format(when);
}
