import type { MouseEvent } from "react";
import type { PeerThread } from "../../shared/types";
import { Toolbar } from "./Toolbar";
import { Transcript } from "./Transcript";
import { CloseIcon } from "./icons";

type Props = {
	thread: PeerThread | null;
	onAnswerPermission(requestId: string, optionId: string): void;
	onClose(): void;
	onMessageMenu?(text: string, event: MouseEvent): void;
};

const ignore = () => {};

export function PeerThreadViewer({ thread, onAnswerPermission, onClose, onMessageMenu }: Props) {
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
			<section className="relative z-raised flex h-full w-full max-w-composer flex-col bg-paper shadow-float animate-slide-in-right">
				<Toolbar as="header" className="gap-xs border-b border-rule px-gutter">
					<h2 className="min-w-0 flex-1 truncate text-sm font-medium text-ink">
						{thread ? `${thread.sides.user.name} ↔ ${thread.sides.agent.name}` : "Thread"}
					</h2>
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

				{thread ? (
					<Transcript
						variant="peer"
						speakers={{ me: thread.sides.user.name, them: thread.sides.agent.name }}
						events={thread.events}
						working={false}
						onAnswerPermission={onAnswerPermission}
						onScrollEdge={ignore}
						onPacing={ignore}
						onMessageMenu={onMessageMenu}
					/>
				) : (
					<div className="flex flex-1 items-center justify-center text-sm text-ink-3">
						Loading thread…
					</div>
				)}
			</section>
		</div>
	);
}
