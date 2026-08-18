import { useState } from "react";
import type {
	Backend,
	PeerActivity,
	Persona,
	Preview,
	SessionInfo,
	SessionState,
} from "../../shared/types";
import { plainOf } from "../messages";
import { api } from "../rpc";
import { Toolbar } from "./Toolbar";
import { CloseIcon, CogIcon, PlusIcon } from "./icons";

/**
 * Each teammate carries a vital sign rather than a generic status pill: the
 * rail is a roster you can watch, so the one moving thing in the whole app is
 * whichever agent is currently working.
 */
const VITAL: Record<SessionState, { className: string; label: string }> = {
	idle: { className: "border-2 border-ink-3", label: "idle" },
	starting: { className: "bg-warn animate-throat", label: "starting" },
	ready: { className: "bg-accent", label: "ready" },
	thinking: { className: "bg-accent animate-throat", label: "working" },
	error: { className: "bg-danger", label: "error" },
	stopped: { className: "border-2 border-ink-3", label: "stopped" },
};

type Props = {
	personas: Persona[];
	backends: Backend[];
	sessions: Record<string, SessionInfo>;
	previews: Record<string, Preview>;
	peerActivity: Record<string, PeerActivity>;
	selectedId: string | null;
	adding: boolean;
	scrolled: boolean;
	/**
	 * True once the window is too narrow to hold the rail beside a conversation,
	 * at which point it slides over the conversation instead of shrinking it.
	 */
	drawer: boolean;
	onAddingChange(adding: boolean): void;
	onScrollEdge(scrolled: boolean): void;
	onSelect(id: string): void;
	onCreate(name: string, backendId: string): Promise<unknown>;
	onOpenAppSettings(): void;
};

export function Sidebar({
	personas,
	backends,
	sessions,
	previews,
	peerActivity,
	selectedId,
	adding,
	scrolled,
	drawer,
	onAddingChange,
	onScrollEdge,
	onSelect,
	onCreate,
	onOpenAppSettings,
}: Props) {
	const [name, setName] = useState("");
	const [backendId, setBackendId] = useState(backends[0]?.id ?? "cursor");
	const [busy, setBusy] = useState(false);

	const submit = async () => {
		const trimmed = name.trim();
		if (!trimmed || busy) return;
		setBusy(true);
		try {
			await onCreate(trimmed, backendId);
			setName("");
			onAddingChange(false);
		} finally {
			setBusy(false);
		}
	};

	const working = personas.filter(
		(p) => sessions[p.id]?.state === "thinking" || sessions[p.id]?.state === "starting",
	).length;

	return (
		<aside
			/* No border down the inside edge: the conversation's corners curve away
			   from it, and a straight rule against a curve reads as a mistake. The
			   step in tone is the seam. */
			className={`flex h-full w-[236px] shrink-0 flex-col bg-paper-2 lg:w-[272px] ${
				/* As a drawer it is lifted off the conversation rather than beside it,
				   so it needs the shadow to say which one is on top. */
				drawer ? "absolute inset-y-0 left-0 z-overlay animate-slide-in shadow-float" : ""
			}`}
		>
			{/* The window's traffic lights are inlaid here, so this segment starts
			    after them and drags the window like the titlebar it replaces. The
			    name sits on their centre line, which is the only line in the window
			    that cannot move. */}
			<Toolbar className="pl-lights" scrolled={scrolled}>
				<h1 className="wordmark">toad</h1>
			</Toolbar>

			<nav
				aria-label="Teammates"
				className="flex-1 overflow-y-auto px-2xs pb-xs pt-2xs"
				onScroll={(e) => onScrollEdge(e.currentTarget.scrollTop > 0)}
			>
				{personas.length === 0 && !adding && (
					<p className="px-xs py-lg text-xs leading-relaxed text-ink-3">
						Add a teammate to get started. Each one keeps its own working directory, its own
						identity, and its own conversation.
					</p>
				)}

				{personas.map((persona, index) => (
					<Row
						key={persona.id}
						persona={persona}
						state={sessions[persona.id]?.state ?? "idle"}
						preview={previews[persona.id]}
						peer={peerActivity[persona.id]}
						/* The roster's first nine are on ⌘1–⌘9, so the row says so — the
						   shortcut is no use to anyone who has to go looking for it. */
						shortcut={index < 9 ? index + 1 : null}
						active={persona.id === selectedId}
						onSelect={() => onSelect(persona.id)}
					/>
				))}
			</nav>

			{adding && (
				<div className="mx-2xs mb-2xs animate-strike rounded-lg border border-rule bg-paper-3 p-sm">
					<input
						autoFocus
						className="field mb-xs"
						placeholder="Teammate name"
						aria-label="Teammate name"
						value={name}
						onChange={(e) => setName(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter") void submit();
							if (e.key === "Escape") onAddingChange(false);
						}}
					/>
					<select
						className="field mb-xs"
						aria-label="Backend"
						value={backendId}
						onChange={(e) => setBackendId(e.target.value)}
					>
						{backends.map((b) => (
							<option key={b.id} value={b.id} disabled={!b.available}>
								{b.name}
								{b.available ? "" : ` — ${b.unavailableReason ?? "not installed"}`}
							</option>
						))}
					</select>
					<button type="button" className="btn-primary w-full" disabled={busy} onClick={submit}>
						{busy ? "Adding…" : "Add teammate"}
					</button>
				</div>
			)}

			{/* Adding a teammate is a sentence, not a glyph. It sits at the foot of
			    the roster because that is where the new row will appear, and the
			    app's own settings sit under it because they are the same kind of
			    thing at a wider scope: what is true of Toad rather than of anyone
			    in the list. */}
			<footer className="border-t border-rule-2 px-2xs py-2xs">
				<button
					type="button"
					className="rail-action"
					aria-expanded={adding}
					title={adding ? "Cancel" : "New teammate (⌘N)"}
					onClick={() => onAddingChange(!adding)}
				>
					{adding ? <CloseIcon /> : <PlusIcon />}
					<span>{adding ? "never mind" : "add teammate"}</span>
				</button>

				<button
					type="button"
					className="rail-action"
					title="Settings (⌘,)"
					onClick={onOpenAppSettings}
				>
					<CogIcon />
					<span>settings</span>
				</button>

				<p className="flex items-center gap-xs px-xs pb-3xs pt-2xs text-2xs text-ink-3">
					{personas.length === 0
						? "no teammates yet"
						: working > 0
							? `${personas.length} teammates · ${working} working`
							: `${personas.length} teammate${personas.length === 1 ? "" : "s"}`}
				</p>
			</footer>
		</aside>
	);
}

function Row({
	persona,
	state,
	preview,
	peer,
	shortcut,
	active,
	onSelect,
}: {
	persona: Persona;
	state: SessionState;
	preview?: Preview;
	peer?: PeerActivity;
	shortcut: number | null;
	active: boolean;
	onSelect(): void;
}) {
	const vital = VITAL[state];

	return (
		<button
			type="button"
			aria-current={active ? "true" : undefined}
			onClick={onSelect}
			onContextMenu={(e) => {
				e.preventDefault();
				onSelect();
				void api.showPersonaMenu(persona.id);
			}}
			className={`rail-row ${active ? "rail-row-on" : ""}`}
		>
			<span className="face" style={{ background: faceOf(persona.id) }} aria-hidden="true">
				{initialOf(persona.name)}
			</span>

			<span className="min-w-0 flex-1">
				<span className="flex items-center gap-2xs">
					<span
						className={`truncate text-sm font-medium ${active ? "text-ink" : "text-ink-2"}`}
					>
						{persona.name}
					</span>
					<span
						aria-hidden="true"
						className={`h-dot w-dot shrink-0 rounded-pill ${vital.className}`}
					/>
					<span className="sr-only">{vital.label}</span>
					{peer && peer.threads > 0 && (
						<>
							<span
								aria-hidden="true"
								className={`h-dot w-dot shrink-0 rounded-pill ${
									peer.waiting
										? "bg-warn animate-throat"
										: "border border-ink-3"
								}`}
							/>
							<span className="sr-only">
								{peer.waiting
									? "peer thread waiting on permission"
									: `${peer.threads} peer thread${peer.threads === 1 ? "" : "s"}`}
							</span>
						</>
					)}
				</span>

				{/* What was last said, or what state it is in when nothing has been.
				    One line either way, so the rows stay a uniform height. */}
				<span className="block truncate text-2xs text-ink-3">
					{preview ? `${preview.from === "me" ? "you: " : ""}${plainOf(preview.text)}` : vital.label}
				</span>
			</span>

			{shortcut && (
				<span aria-hidden="true" className="shrink-0 font-mono text-2xs text-ink-3">
					⌘{shortcut}
				</span>
			)}
		</button>
	);
}

/* Seven faces and no way to choose, so the id picks. A hash rather than the
 * roster position, because a teammate's face should not change when the one
 * above it is deleted. */
function faceOf(personaId: string): string {
	let hash = 0;
	for (let index = 0; index < personaId.length; index++) {
		hash = (hash * 31 + personaId.charCodeAt(index)) % 1_000_003;
	}
	return `var(--face-${(hash % 7) + 1})`;
}

/** The first letter that is one, so "⌘kill bill" and " Ada" both read right. */
function initialOf(name: string): string {
	return (name.match(/\p{L}|\p{N}/u)?.[0] ?? "?").toUpperCase();
}
