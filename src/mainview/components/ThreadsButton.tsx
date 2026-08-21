import type { PeerThreadSummary } from "../../shared/types";
import { ThreadsIcon } from "./icons";

type Props = {
	threads: PeerThreadSummary[];
	/** When this teammate's threads were last looked at. */
	seenAt: number;
	open: boolean;
	onOpen(): void;
};

/**
 * The way into a teammate's side conversations, next to the control that opens
 * its settings because both are drawers onto the same person.
 *
 * Three states, and the quiet one is the point: dim when there are no threads at
 * all, plain when there are but you have seen them, and lit with a count when
 * there is something you have not. A control that looks the same whether or not
 * two of your teammates have been talking is a control you have to click to
 * learn anything from.
 *
 * The count is threads, not messages. What you do next is open one, so the
 * number that helps is how many there are to open — a message total would climb
 * into the dozens while the list it stands for still has two rows in it.
 */
export function ThreadsButton({ threads, seenAt, open, onOpen }: Props) {
	const waiting = threads.filter((thread) => thread.waiting).length;
	/* Waiting counts as unseen however long it has been sitting there: a peer
	 * thread blocked on a permission is not news you can finish reading. */
	const news = threads.filter((thread) => thread.waiting || thread.lastAt > seenAt).length;
	const label = threadsLabel(threads.length, news, waiting);

	return (
		<button
			type="button"
			aria-label={label}
			aria-expanded={open}
			title={label}
			disabled={threads.length === 0}
			className={`btn-ghost relative shrink-0 !px-xs ${open ? "bg-paper-4 text-ink" : ""} ${
				threads.length > 0 && !open ? "text-ink" : ""
			}`}
			onClick={onOpen}
		>
			<ThreadsIcon />
			{news > 0 && (
				<span className="count-badge" data-waiting={waiting > 0} aria-hidden="true">
					{news}
				</span>
			)}
		</button>
	);
}

function threadsLabel(total: number, news: number, waiting: number): string {
	if (total === 0) return "No threads";
	const threads = `${total} thread${total === 1 ? "" : "s"}`;
	if (waiting > 0) return `${threads}, ${waiting} waiting on you`;
	if (news > 0) return `${threads}, ${news} new`;
	return threads;
}
