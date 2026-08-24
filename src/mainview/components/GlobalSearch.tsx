import { useEffect, useRef, useState } from "react";
import { composeFallbackFace } from "../../shared/face";
import type { GlobalSearchHit, Persona } from "../../shared/types";
import { webClient } from "../platform";
import { api } from "../rpc";
import { FaceIcon } from "./FaceIcon";
import { CloseIcon } from "./icons";
import { Toolbar } from "./Toolbar";

/**
 * One search over every conversation.
 *
 * The index has always held the whole team — searching one teammate at a
 * time was a WHERE clause wearing a drawer. Now there is one place to ask
 * "where did we say X", and the answer names who said it: each hit carries
 * the teammate's face, and picking one lands in that conversation at that
 * message. Chapters outrank messages for the reason they always did — a
 * note is an agent's own summary of the thing, not the wording of it.
 *
 * Chapter housekeeping (starting a fresh one) lives in the teammate's
 * Session settings, where it always belonged; a search box is for finding.
 */

type Props = {
	personas: Persona[];
	onPick(personaId: string, eventId?: string): void;
	onClose(): void;
};

export function GlobalSearch({ personas, onPick, onClose }: Props) {
	const [query, setQuery] = useState("");
	const [found, setFound] = useState<{ hits: GlobalSearchHit[]; truncated: boolean } | null>(null);
	const input = useRef<HTMLInputElement>(null);
	const phone = webClient();

	useEffect(() => {
		input.current?.focus();
	}, []);

	useEffect(() => {
		const needle = query.trim();
		if (needle.length < 2) {
			setFound(null);
			return;
		}
		let cancelled = false;
		const timer = setTimeout(() => {
			void api.searchAllThreads(needle, 40).then(
				(result) => {
					if (!cancelled) setFound(result);
				},
				() => {
					if (!cancelled) setFound({ hits: [], truncated: false });
				},
			);
		}, 140);
		return () => {
			cancelled = true;
			clearTimeout(timer);
		};
	}, [query]);

	const byId = new Map(personas.map((persona) => [persona.id, persona]));
	const searching = query.trim().length >= 2;

	const field = (
		<input
			ref={input}
			className="field min-w-0 flex-1"
			type="search"
			placeholder="Search every conversation"
			aria-label="Search every conversation"
			value={query}
			onChange={(event) => setQuery(event.target.value)}
			enterKeyHint="search"
		/>
	);

	return (
		<div
			className="absolute inset-x-0 bottom-0 top-toolbar z-overlay flex justify-end"
			role="dialog"
			aria-modal="true"
		>
			<button
				type="button"
				className="sheet-scrim animate-fade-in"
				aria-label="Close search"
				onClick={onClose}
			/>
			<section className="threads-drawer gsearch animate-slide-in-right">
				{phone ? (
					<header className="gsearch-head">
						{field}
						<button type="button" className="peer-done static" onClick={onClose}>
							Cancel
						</button>
					</header>
				) : (
					<Toolbar as="header" className="gap-xs border-b border-rule px-sm">
						{field}
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
				)}

				<div className="min-h-0 flex-1 overflow-y-auto py-2xs">
					{!searching && (
						<p className="px-sm py-xs text-xs leading-relaxed text-ink-3">
							Everything anyone has said, and every chapter note an agent wrote — across the whole
							team.
						</p>
					)}
					{searching && found && found.hits.length === 0 && (
						<p className="px-sm py-xs text-xs text-ink-3">Nothing matches that yet.</p>
					)}
					{searching &&
						found?.hits.map((hit) => {
							const persona = byId.get(hit.personaId);
							const face =
								persona?.face ?? composeFallbackFace(persona?.name ?? "?", persona?.goal ?? "");
							return (
								<button
									key={hit.kind === "chapter" ? hit.chapterId : hit.eventId}
									type="button"
									className="gsearch-hit"
									onClick={() =>
										onPick(hit.personaId, hit.kind === "chapter" ? hit.chapterId : hit.eventId)
									}
								>
									<span className="gsearch-face" aria-hidden="true">
										<FaceIcon face={face} size={28} />
									</span>
									<span className="min-w-0 flex-1">
										<span className="flex items-baseline gap-2xs">
											<span className="min-w-0 truncate text-sm font-medium text-ink-2">
												{hit.kind === "chapter"
													? `${persona?.name ?? "?"} · ${hit.title}`
													: persona?.name ?? "?"}
											</span>
											<span className="shrink-0 text-2xs text-ink-3">{when(hit.ts)}</span>
										</span>
										<span className="block truncate text-left text-2xs text-ink-3">
											{hit.kind === "message" && hit.from === "me" ? "You: " : ""}
											{hit.excerpt}
										</span>
									</span>
								</button>
							);
						})}
					{found?.truncated && (
						<p className="px-sm py-xs text-2xs text-ink-3">More matches exist — narrow the words.</p>
					)}
				</div>
			</section>
		</div>
	);
}

function when(ts: number): string {
	const date = new Date(ts);
	const now = new Date();
	const sameYear = date.getFullYear() === now.getFullYear();
	if (date.toDateString() === now.toDateString())
		return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
	return date.toLocaleDateString([], sameYear ? { month: "short", day: "numeric" } : { year: "numeric", month: "short" });
}
