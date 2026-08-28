import { type MouseEvent, useMemo } from "react";
import type { PeerThread, TranscriptEvent } from "../../shared/types";
import { webClient } from "../platform";
import { Toolbar } from "./Toolbar";
import { Transcript } from "./Transcript";
import { CloseIcon } from "./icons";

type Props = {
	thread: PeerThread | null;
	/** The teammate whose header opened this thread — always the outgoing side. */
	selfId: string | null;
	onAnswerPermission(requestId: string, optionId: string): void;
	onClose(): void;
	onMessageMenu?(text: string, event: MouseEvent): void;
};

const ignore = () => {};

/**
 * Reads a stored peer thread from one participant's chair.
 *
 * `sides.user`/`sides.agent` are the *file's* orientation, not a point of view:
 * thread meta hands those two roles to the participants by sorted persona id,
 * and every stored event's kind is written in those terms. So which side is
 * outgoing depends on whose thread you opened, and for half of all pairs the
 * reader is the stored `agent`. Flipping the kinds here — rather than swapping
 * only the names — is what actually moves the bubbles: the transcript decides
 * left/right from `kind`, and `speakers` only labels the runs.
 */
function oriented(thread: PeerThread, selfId: string | null) {
	const mineIsAgent = thread.sides.agent.personaId === selfId;
	const me = mineIsAgent ? thread.sides.agent : thread.sides.user;
	const them = mineIsAgent ? thread.sides.user : thread.sides.agent;
	const events: TranscriptEvent[] = mineIsAgent
		? thread.events.map((event) =>
				event.kind === "user"
					? { ...event, kind: "agent" as const }
					: event.kind === "agent"
						? { ...event, kind: "user" as const }
						: event,
			)
		: thread.events;
	return { me, them, events };
}

export function PeerThreadViewer({
	thread,
	selfId,
	onAnswerPermission,
	onClose,
	onMessageMenu,
}: Props) {
	const view = useMemo(() => (thread ? oriented(thread, selfId) : null), [thread, selfId]);
	const title = view ? `${view.me.name} & ${view.them.name}` : "Thread";
	return (
		<div
			/* Same box as the threads list it opens from, so one covers the other
			   exactly and the teammate's own header stays put above both. */
			className="absolute inset-x-0 bottom-0 top-toolbar z-overlay flex justify-end"
			role="dialog"
			aria-modal="true"
		>
			<button
				type="button"
				className="sheet-scrim animate-fade-in"
				aria-label="Close thread"
				onClick={onClose}
			/>
			<section className="pane-drawer relative z-raised flex h-full w-full max-w-composer flex-col bg-paper shadow-float animate-slide-in-right">
				{/* The names, joined the way two colleagues are — an ampersand, not
				    U+2194, which iOS insists on drawing as an emoji. The phone gets
				    sheet grammar (the drawer's own grab bar, a centred title, Done);
				    a toolbar with an ✕ belongs to windows. */}
				{webClient() ? (
					<header className="peer-head">
						<h2 className="peer-title">{title}</h2>
						<button type="button" className="peer-done" onClick={onClose}>
							Done
						</button>
					</header>
				) : (
					<Toolbar as="header" className="gap-xs border-b border-rule px-gutter">
						<h2 className="min-w-0 flex-1 truncate text-sm font-medium text-ink">{title}</h2>
						<button
							autoFocus
							type="button"
							className="btn-ghost !px-xs"
							aria-label="Close thread"
							title="Close"
							onClick={onClose}
						>
							<CloseIcon />
						</button>
					</Toolbar>
				)}

				{view ? (
					<Transcript
						variant="peer"
						speakers={{ me: view.me.name, them: view.them.name }}
						events={view.events}
						working={false}
						onAnswerPermission={onAnswerPermission}
						onScrollEdge={ignore}
						onPacing={ignore}
						onMessageMenu={
							onMessageMenu ? (info, event) => onMessageMenu(info.text, event) : undefined
						}
					/>
				) : (
					<div className="flex flex-1 items-center justify-center text-sm text-ink-3">
						Loading thread… if the desktop just restarted, this catches up on its own.
					</div>
				)}
			</section>
		</div>
	);
}
