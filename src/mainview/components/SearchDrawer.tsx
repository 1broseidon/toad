import { useEffect, useRef, useState } from "react";
import type { ChapterSummary, ThreadSearchHit } from "../../shared/types";
import { api } from "../rpc";
import { CloseIcon } from "./icons";
import { Toolbar } from "./Toolbar";

type Props = {
	personaId: string;
	/** The chapter markers this conversation holds, newest first. */
	onJump(eventId: string): void;
	onClose(): void;
};

/**
 * Search over one conversation, and the table of contents it starts from.
 *
 * Empty, it lists the chapters — each a stretch of the conversation that was
 * one working context for the agent, named when it closed. Typing searches
 * chapter notes first and messages second, because a note is an agent's own
 * summary and hits on it are about the thing, not the wording. Picking a
 * result scrolls the transcript to it; the drawer stays, so the next result
 * is one click rather than three.
 *
 * It sits on the right edge for the same reason the threads list does: the
 * roster on the left answers "who", and this answers "when did we".
 */
export function SearchDrawer({ personaId, onJump, onClose }: Props) {
	const [query, setQuery] = useState("");
	const [chapters, setChapters] = useState<ChapterSummary[] | null>(null);
	const [hits, setHits] = useState<{ hits: ThreadSearchHit[]; truncated: boolean } | null>(null);
	const [freshening, setFreshening] = useState(false);
	const [freshened, setFreshened] = useState<string | null>(null);
	const [shownNote, setShownNote] = useState<string | null>(null);
	const input = useRef<HTMLInputElement>(null);

	const loadChapters = () => {
		void api.listChapters(personaId).then(setChapters, () => setChapters([]));
	};

	useEffect(() => {
		setChapters(null);
		setHits(null);
		setQuery("");
		setFreshened(null);
		loadChapters();
		input.current?.focus();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [personaId]);

	/* Searches as you type, a beat behind the keystrokes. The index is local
	 * and fast; the debounce is for the list not to flicker per letter. */
	useEffect(() => {
		const needle = query.trim();
		if (needle.length < 2) {
			setHits(null);
			return;
		}
		let cancelled = false;
		const timer = setTimeout(() => {
			void api.searchThread(personaId, needle, 30).then(
				(result) => {
					if (!cancelled) setHits(result);
				},
				() => {
					if (!cancelled) setHits({ hits: [], truncated: false });
				},
			);
		}, 140);
		return () => {
			cancelled = true;
			clearTimeout(timer);
		};
	}, [personaId, query]);

	const startFresh = async () => {
		setFreshening(true);
		try {
			const { title } = await api.startFreshChapter(personaId);
			setFreshened(title ? `Closed “${title}”. The next message starts fresh.` : "The next message starts fresh.");
			loadChapters();
		} catch (error) {
			setFreshened(error instanceof Error ? error.message : String(error));
		} finally {
			setFreshening(false);
		}
	};

	const searching = query.trim().length >= 2;

	return (
		<div
			className="absolute inset-x-0 bottom-0 top-toolbar z-overlay flex justify-end"
			role="dialog"
			aria-label="Search this conversation"
		>
			<button
				type="button"
				className="sheet-scrim animate-fade-in"
				aria-label="Close search"
				onClick={onClose}
			/>
			<section className="threads-drawer animate-slide-in-right">
				<Toolbar as="header" className="gap-xs border-b border-rule px-sm">
					<input
						ref={input}
						type="search"
						className="field min-w-0 flex-1"
						placeholder="Search this conversation"
						aria-label="Search this conversation"
						value={query}
						onChange={(event) => setQuery(event.target.value)}
					/>
					<button
						type="button"
						className="btn-ghost !px-xs"
						aria-label="Close search"
						title="Close"
						onClick={onClose}
					>
						<CloseIcon />
					</button>
				</Toolbar>

				<div className="min-h-0 flex-1 overflow-y-auto py-2xs">
					{searching ? (
						<Hits hits={hits} onJump={onJump} />
					) : (
						<Chapters
							chapters={chapters}
							shownNote={shownNote}
							onToggleNote={(id) => setShownNote((current) => (current === id ? null : id))}
							onJump={onJump}
						/>
					)}
				</div>

				{!searching && (
					<footer className="flex flex-col gap-2xs border-t border-rule px-sm py-xs">
						<button type="button" className="btn-outline" disabled={freshening} onClick={() => void startFresh()}>
							{freshening ? "Closing the chapter…" : "Start a new chapter"}
						</button>
						<p className="m-0 text-2xs leading-relaxed text-ink-3">
							{freshened ??
								"Closes the current chapter with a handoff note, so the next message starts with a fresh context. Chapters also close on their own after a long idle."}
						</p>
					</footer>
				)}
			</section>
		</div>
	);
}

function Chapters({
	chapters,
	shownNote,
	onToggleNote,
	onJump,
}: {
	chapters: ChapterSummary[] | null;
	shownNote: string | null;
	onToggleNote(id: string): void;
	onJump(eventId: string): void;
}) {
	if (chapters === null) return <p className="px-sm py-xs text-xs text-ink-3">Loading…</p>;
	const listed = chapters.filter((chapter) => chapter.endedAt === undefined || chapter.title);
	if (listed.length === 0) {
		return (
			<p className="px-sm py-xs text-xs text-ink-3">
				No chapters yet. One closes when this teammate has been idle for a while, and the
				conversation picks up fresh afterwards.
			</p>
		);
	}
	return (
		<>
			{listed.map((chapter) => (
				<div key={chapter.id} className="search-row">
					<button type="button" className="search-hit" onClick={() => onJump(chapter.id)}>
						<span className="flex items-center gap-2xs">
							<span className="min-w-0 flex-1 truncate text-sm font-medium text-ink-2">
								{chapter.title ?? (chapter.endedAt === undefined ? "Current chapter" : "Chapter")}
							</span>
							<span className="shrink-0 text-2xs text-ink-3">{when(chapter.startedAt)}</span>
						</span>
						<span className="block truncate text-left text-2xs text-ink-3">
							{chapter.endedAt === undefined ? "open" : chapter.status === "in-progress" ? "unfinished" : "done"}
							{" · "}
							{chapter.messages} message{chapter.messages === 1 ? "" : "s"}
						</span>
					</button>
					{chapter.note && (
						<button
							type="button"
							className="search-note-toggle"
							aria-expanded={shownNote === chapter.id}
							onClick={() => onToggleNote(chapter.id)}
						>
							{shownNote === chapter.id ? "hide note" : "note"}
						</button>
					)}
					{shownNote === chapter.id && chapter.note && (
						<pre className="chapter-note mx-sm mb-xs">{chapter.note}</pre>
					)}
				</div>
			))}
		</>
	);
}

function Hits({
	hits,
	onJump,
}: {
	hits: { hits: ThreadSearchHit[]; truncated: boolean } | null;
	onJump(eventId: string): void;
}) {
	if (hits === null) return <p className="px-sm py-xs text-xs text-ink-3">Searching…</p>;
	if (hits.hits.length === 0) {
		return <p className="px-sm py-xs text-xs text-ink-3">Nothing matched. Try another word for it.</p>;
	}
	return (
		<>
			{hits.hits.map((hit) =>
				hit.kind === "chapter" ? (
					<button
						key={`c:${hit.chapterId}`}
						type="button"
						className="search-hit"
						onClick={() => onJump(hit.chapterId)}
					>
						<span className="flex items-center gap-2xs">
							<span className="min-w-0 flex-1 truncate text-sm font-medium text-ink-2">{hit.title}</span>
							<span className="shrink-0 text-2xs text-ink-3">chapter · {when(hit.ts)}</span>
						</span>
						<span className="block truncate text-left text-2xs text-ink-3">{hit.excerpt}</span>
					</button>
				) : (
					<button
						key={`m:${hit.eventId}`}
						type="button"
						className="search-hit"
						onClick={() => onJump(hit.eventId)}
					>
						<span className="flex items-center gap-2xs">
							<span className="min-w-0 flex-1 truncate text-sm text-ink-2">
								{hit.from === "me" ? "You" : "Teammate"}
							</span>
							<span className="shrink-0 text-2xs text-ink-3">{when(hit.ts)}</span>
						</span>
						<span className="block truncate text-left text-2xs text-ink-3">{hit.excerpt}</span>
					</button>
				),
			)}
			{hits.truncated && (
				<p className="px-sm py-xs text-2xs text-ink-3">More matched than are shown. Narrow the search.</p>
			)}
		</>
	);
}

const clock = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const day = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });

function when(at: number): string {
	const date = new Date(at);
	const today = new Date();
	const sameDay =
		date.getFullYear() === today.getFullYear() &&
		date.getMonth() === today.getMonth() &&
		date.getDate() === today.getDate();
	return sameDay ? clock.format(date) : day.format(date);
}
