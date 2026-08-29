import { useEffect, useState } from "react";
import type { ChapterSummary, SessionInfo } from "../../../../shared/types";
import { api } from "../../../rpc";
import { Detail, Field, Section } from "../../fields";

type Props = {
	info: SessionInfo | null;
	personaId: string;
	/**
	 * Present only on the phone, where this pane is the one place the session's
	 * lifecycle can be acted on. The desktop leaves it out — there the acts
	 * live in the teammate's menu and its shortcuts.
	 */
	lifecycle?: { running: boolean; onStart(): void; onStop(): void };
};

/**
 * The agent's memory, as distinct from Toad's record of the conversation.
 *
 * Two facts live here. Whether the live session genuinely remembers what is
 * on screen (Restored) or is reading Toad's notes (Fresh), and how the
 * conversation is divided into chapters — each one working context, closed
 * with a handoff note. Starting a new chapter is offered here as well as in
 * search, because this is where someone comes to understand what the agent
 * does and does not have in its head.
 */
export function Session({ info, personaId, lifecycle }: Props) {
	const [chapters, setChapters] = useState<ChapterSummary[] | null>(null);
	const [busy, setBusy] = useState(false);
	const [said, setSaid] = useState<string | null>(null);

	const refresh = () => {
		void api.listChapters(personaId).then(setChapters, () => setChapters([]));
	};

	useEffect(() => {
		setChapters(null);
		setSaid(null);
		refresh();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [personaId]);

	const open = chapters?.find((chapter) => chapter.endedAt === undefined);
	const closed = chapters?.filter((chapter) => chapter.endedAt !== undefined && chapter.title) ?? [];

	const startFresh = async () => {
		setBusy(true);
		try {
			const { title } = await api.startFreshChapter(personaId);
			setSaid(title ? `Closed “${title}”.` : "Done. The next message starts fresh.");
			refresh();
		} catch (error) {
			setSaid(error instanceof Error ? error.message : String(error));
		} finally {
			setBusy(false);
		}
	};

	return (
		<Section
			title="Session"
			hint="Toad keeps its own transcript. This is the agent's own memory of the conversation, which it restores when it can."
		>
			{info?.sessionId ? (
				<dl className="flex flex-col gap-3xs text-xs text-ink-3">
					<Detail term="Id" value={info.sessionId} mono />
					<Detail term="Context" value={info.contextRestored ? "Restored" : "Fresh"} />
					<Detail
						term="Restore"
						value={
							info.capabilities.resume
								? "resume"
								: info.capabilities.loadSession
									? "load"
									: "not supported"
						}
					/>
				</dl>
			) : (
				<p className="text-xs leading-relaxed text-ink-3">
					No session yet. One starts when you send a message.
				</p>
			)}

			{lifecycle && (
				<div className="flex items-center">
					<button
						type="button"
						className="btn-outline"
						onClick={lifecycle.running ? lifecycle.onStop : lifecycle.onStart}
					>
						{lifecycle.running ? "Stop session" : "Start session"}
					</button>
				</div>
			)}

			<Field
				label="Chapters"
				hint="The conversation is one long thread, but the agent works in one chapter of it at a time. A chapter closes after a long idle (Settings → General), when you ask, or when the agent decides the subject has changed — with a handoff note the next chapter reads on wake."
			>
				<p className="m-0 text-xs text-ink-3">
					{chapters === null
						? "Loading…"
						: `${closed.length} closed${open ? `, one open with ${open.messages} message${open.messages === 1 ? "" : "s"}` : ""}.`}
				</p>
				<div className="mt-xs flex items-center gap-sm">
					<button type="button" className="btn-outline" disabled={busy} onClick={() => void startFresh()}>
						{busy ? "Closing…" : "Start a new chapter"}
					</button>
					{said && <span className="text-2xs text-ink-3">{said}</span>}
				</div>
			</Field>
		</Section>
	);
}
