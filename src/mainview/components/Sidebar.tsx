import {
	useRef,
	useState,
	type DragEvent as ReactDragEvent,
	type MouseEvent,
	type ReactNode,
	type TouchEvent as ReactTouchEvent,
} from "react";
import { flattenTeamRoster, personaTeam } from "../../shared/roster";
import { isBusy } from "../../shared/session";
import type {
	PeerActivity,
	Persona,
	Preview,
	ScheduledJob,
	SessionInfo,
	SessionState,
} from "../../shared/types";
import { jobLine } from "../useSchedules";
import { hapticHold, hapticTap } from "../haptics";
import { timeAgoShort } from "../messages";
import { plainOf } from "../messages";
import { shortcutLabel, webClient } from "../platform";
import { FaceIcon } from "./FaceIcon";
import { RailShell } from "./RailShell";
import { CloseIcon, CogIcon, PlusIcon, SearchIcon } from "./icons";

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

/** A held finger's two thresholds: still past MENU_MS is the menu; moved
 * after LIFT_MS is a lift. Moved before LIFT_MS it was always a scroll. */
const MENU_MS = 450;
const LIFT_MS = 250;

type Props = {
	personas: Persona[];
	sessions: Record<string, SessionInfo>;
	previews: Record<string, Preview>;
	peerActivity: Record<string, PeerActivity>;
	schedules: Record<string, ScheduledJob[]>;
	selectedId: string | null;
	adding: boolean;
	scrolled: boolean;
	/**
	 * True once the window is too narrow to hold the rail beside a conversation,
	 * at which point it slides over the conversation instead of shrinking it.
	 */
	drawer: boolean;
	/** The phone's base screen — see RailShell. */
	stackBase?: boolean;
	/** See RailShell. */
	stackCovered?: boolean;
	/**
	 * Which machine this roster belongs to, on the shell where that is a
	 * question. Nothing on a desktop, which is only ever itself.
	 */
	beforeFooter?: ReactNode;
	/** Opens the team-wide search; the magnifier on the title line. */
	onSearch?(): void;
	onAddingChange(adding: boolean): void;
	onScrollEdge(scrolled: boolean): void;
	onSelect(id: string): void;
	onOpenAppSettings(): void;
	onPersonaMenu(personaId: string, event: MouseEvent): void;
	/**
	 * A drag ended: the roster's whole new order, and where the moved teammate
	 * landed — including which team's section, since dropping into another
	 * team is how a teammate changes teams.
	 */
	onArrange?(ids: string[], moved: { id: string; team?: string }): void;
};

/** Where a drag currently hovers: before a row, or at a team's end. */
type DropSpot = { beforeId: string; team?: string } | { endOfTeam: string };

export function Sidebar({
	personas,
	sessions,
	previews,
	peerActivity,
	schedules,
	selectedId,
	adding,
	scrolled,
	drawer,
	stackBase,
	stackCovered,
	beforeFooter,
	onSearch,
	onAddingChange,
	onScrollEdge,
	onSelect,
	onOpenAppSettings,
	onPersonaMenu,
	onArrange,
}: Props) {
	const working = personas.filter((p) => {
		const state = sessions[p.id]?.state;
		return state !== undefined && isBusy(state);
	}).length;

	/* -------------------------------------------------------------- sections
	 * Unteamed rows first with no header — the default costs nothing — then
	 * each team under its label, in order of first appearance. The flattened
	 * order is the one ⌘1–9 and drags speak in. */
	const flat = flattenTeamRoster(personas);
	const teamNames: string[] = [];
	for (const persona of flat) {
		const team = personaTeam(persona);
		if (team && !teamNames.includes(team)) teamNames.push(team);
	}
	const sections: Array<{ team?: string; items: Persona[] }> = [
		{ items: flat.filter((persona) => !personaTeam(persona)) },
		...teamNames.map((team) => ({
			team,
			items: flat.filter((persona) => personaTeam(persona) === team),
		})),
	];
	const shortcutById = new Map(flat.map((persona, index) => [persona.id, index + 1]));

	/* ------------------------------------------------------------------ drag
	 * One commit path for both platforms: the desktop drags with HTML5, the
	 * phone lifts a held row — hold still and it is the menu, hold then move
	 * and the row comes with the finger, the home screen's own grammar. */
	const dragId = useRef<string | null>(null);
	const [lifted, setLifted] = useState<string | null>(null);
	const [spot, setSpot] = useState<DropSpot | null>(null);
	const spotRef = useRef<DropSpot | null>(null);
	const place = (next: DropSpot | null) => {
		spotRef.current = next;
		setSpot(next);
	};

	const beginDrag = (id: string) => {
		dragId.current = id;
		setLifted(id);
	};
	const hoverAt = (x: number, y: number) => {
		const el = document.elementFromPoint(x, y);
		const row = el?.closest?.("[data-drop-row]") as HTMLElement | null;
		if (row && row.dataset.dropRow !== dragId.current) {
			place({ beforeId: row.dataset.dropRow!, team: row.dataset.dropTeam || undefined });
			return;
		}
		const head = el?.closest?.("[data-drop-team]") as HTMLElement | null;
		if (head?.dataset.dropTeam) place({ endOfTeam: head.dataset.dropTeam });
	};
	const endDrag = (commit: boolean) => {
		const id = dragId.current;
		const at = spotRef.current;
		dragId.current = null;
		setLifted(null);
		place(null);
		if (!commit || !id || !at || !onArrange) return;

		const rest = flat.filter((persona) => persona.id !== id);
		let ids: string[];
		let team: string | undefined;
		if ("beforeId" in at) {
			if (at.beforeId === id) return;
			team = at.team;
			ids = rest.flatMap((persona) =>
				persona.id === at.beforeId ? [id, persona.id] : [persona.id],
			);
		} else {
			team = at.endOfTeam;
			const tail = rest.filter((persona) => personaTeam(persona) === team);
			const last = tail[tail.length - 1];
			ids = last
				? rest.flatMap((persona) => (persona.id === last.id ? [persona.id, id] : [persona.id]))
				: [...rest.map((persona) => persona.id), id];
		}
		if (ids.length !== flat.length) return;
		onArrange(ids, { id, team });
	};

	return (
		<RailShell
			drawer={drawer}
			stackBase={stackBase}
			stackCovered={stackCovered}
			scrolled={scrolled}
			// The roster holds the window's left edge even as a drawer, so the
			// mark keeps clear of the traffic lights either way.
			underLights
			navLabel="Team"
			onScrollEdge={onScrollEdge}
			beforeFooter={beforeFooter}
			headerAction={
				onSearch && (
					<button
						type="button"
						className="rail-search"
						aria-label="Search every conversation"
						onClick={onSearch}
					>
						<SearchIcon />
					</button>
				)
			}
			/* Adding a teammate is a sentence, not a glyph. It sits at the foot of
			   the roster because that is where the new row will appear, and the
			   app's own settings sit under it because they are the same kind of
			   thing at a wider scope: what is true of Toad rather than of anyone
			   in the list. */
			footer={
				<>
					<button
						type="button"
						className="rail-action"
						aria-expanded={adding}
						title={adding ? "Cancel" : `New teammate (${shortcutLabel("N")})`}
						onClick={() => onAddingChange(!adding)}
					>
						{adding ? <CloseIcon /> : <PlusIcon />}
						<span>{adding ? "Never mind" : "Add teammate"}</span>
					</button>

					<button
						type="button"
						className="rail-action"
						title={`Settings (${shortcutLabel(",")})`}
						onClick={onOpenAppSettings}
					>
						<CogIcon />
						<span>Settings</span>
					</button>

					{!webClient() && (
						<p className="flex items-center gap-xs px-xs pt-2xs text-2xs text-ink-3">
							{personas.length === 0
								? "no one on the team yet"
								: working > 0
									? `${personas.length} on the team · ${working} working`
									: `${personas.length} on the team`}
						</p>
					)}
				</>
			}
		>
			{personas.length === 0 && !adding && (
				<p className="px-xs py-lg text-xs leading-relaxed text-ink-3">
					Add a teammate to get started. Each one keeps its own working directory, its own
					identity, and its own conversation.
				</p>
			)}

			{sections.map((section) =>
				section.items.length === 0 && !section.team ? null : (
					<div key={section.team ?? "·"}>
						{section.team && (
							<p
								className="rail-team"
								data-drop-team={section.team}
								onDragOver={(event) => {
									if (!dragId.current) return;
									event.preventDefault();
									place({ endOfTeam: section.team! });
								}}
								onDrop={(event) => {
									event.preventDefault();
									endDrag(true);
								}}
							>
								{section.team}
							</p>
						)}
						{section.items.map((persona) => {
							const shortcut = shortcutById.get(persona.id) ?? 10;
							return (
								<Row
									key={persona.id}
									persona={persona}
									team={personaTeam(persona)}
									state={sessions[persona.id]?.state ?? "idle"}
									preview={previews[persona.id]}
									peer={peerActivity[persona.id]}
									jobs={schedules[persona.id] ?? []}
									/* The roster's first nine are on ⌘1–⌘9, so the row says so —
									   the shortcut is no use to anyone who has to go looking for
									   it. */
									shortcut={shortcut <= 9 ? shortcut : null}
									active={persona.id === selectedId}
									lifted={lifted === persona.id}
									dropBefore={
										spot !== null && "beforeId" in spot && spot.beforeId === persona.id
									}
									draggable={Boolean(onArrange)}
									onSelect={() => onSelect(persona.id)}
									onMenu={(event) => onPersonaMenu(persona.id, event)}
									onLift={() => beginDrag(persona.id)}
									onLiftMove={hoverAt}
									onLiftEnd={endDrag}
									onDragStartRow={() => beginDrag(persona.id)}
									onDragOverRow={(event) => {
										if (!dragId.current) return;
										event.preventDefault();
										hoverAt(event.clientX, event.clientY);
									}}
									onDropRow={(event) => {
										event.preventDefault();
										endDrag(true);
									}}
									onDragEndRow={() => endDrag(false)}
								/>
							);
						})}
					</div>
				),
			)}
		</RailShell>
	);
}

function Row({
	persona,
	team,
	state,
	preview,
	peer,
	jobs,
	shortcut,
	active,
	lifted,
	dropBefore,
	draggable,
	onSelect,
	onMenu,
	onLift,
	onLiftMove,
	onLiftEnd,
	onDragStartRow,
	onDragOverRow,
	onDropRow,
	onDragEndRow,
}: {
	persona: Persona;
	team?: string;
	state: SessionState;
	preview?: Preview;
	peer?: PeerActivity;
	jobs: ScheduledJob[];
	shortcut: number | null;
	active: boolean;
	lifted: boolean;
	dropBefore: boolean;
	draggable: boolean;
	onSelect(): void;
	onMenu(event: MouseEvent): void;
	onLift(): void;
	onLiftMove(x: number, y: number): void;
	onLiftEnd(commit: boolean): void;
	onDragStartRow(): void;
	onDragOverRow(event: ReactDragEvent): void;
	onDropRow(event: ReactDragEvent): void;
	onDragEndRow(): void;
}) {
	const vital = VITAL[state];
	const rowEl = useRef<HTMLButtonElement>(null);
	/* iOS never fires `contextmenu`, so the row watches the touch itself. Held
	 * still for a beat it is the platform's right-click and opens the menu;
	 * moved at once it is a scroll; held briefly and THEN moved, the row lifts
	 * and comes along with the finger. The click that follows either gesture
	 * is swallowed, or it would push the conversation too. */
	const press = useRef<{ x: number; y: number; at: number; timer: number } | null>(null);
	const pressFired = useRef(false);
	const cancelPress = () => {
		if (press.current) window.clearTimeout(press.current.timer);
		press.current = null;
	};
	const onTouchStart = (event: ReactTouchEvent) => {
		const touch = event.touches[0];
		if (!touch || event.touches.length > 1) return;
		cancelPress();
		pressFired.current = false;
		const { clientX, clientY } = touch;
		press.current = {
			x: clientX,
			y: clientY,
			at: Date.now(),
			timer: window.setTimeout(() => {
				press.current = null;
				pressFired.current = true;
				hapticHold();
				onMenu({ clientX, clientY, preventDefault() {} } as unknown as MouseEvent);
			}, MENU_MS),
		};
	};
	const liftNow = () => {
		pressFired.current = true;
		hapticTap();
		onLift();
		const el = rowEl.current;
		if (!el) return;
		const move = (ev: globalThis.TouchEvent) => {
			/* Scroll must not fight the drag. React's root touch listeners are
			 * passive, so this native one is where the gesture gets claimed. */
			ev.preventDefault();
			const t = ev.touches[0];
			if (t) onLiftMove(t.clientX, t.clientY);
		};
		const finish = (commit: boolean) => {
			el.removeEventListener("touchmove", move);
			el.removeEventListener("touchend", commitEnd);
			el.removeEventListener("touchcancel", cancelEnd);
			onLiftEnd(commit);
		};
		const commitEnd = () => finish(true);
		const cancelEnd = () => finish(false);
		el.addEventListener("touchmove", move, { passive: false });
		el.addEventListener("touchend", commitEnd);
		el.addEventListener("touchcancel", cancelEnd);
	};
	const onTouchMove = (event: ReactTouchEvent) => {
		const touch = event.touches[0];
		if (!press.current || !touch) return;
		if (Math.hypot(touch.clientX - press.current.x, touch.clientY - press.current.y) > 10) {
			const held = Date.now() - press.current.at;
			cancelPress();
			if (draggable && webClient() && held >= LIFT_MS) liftNow();
		}
	};
	/* The phone's rows carry a timestamp the way a messages app does — the
	 * desktop's rail is narrow and lives beside the conversation, so it
	 * does not. */
	const phone = webClient();
	const when = phone && preview ? timeAgoShort(preview.at) : null;
	const busy = isBusy(state);

	return (
		<button
			ref={rowEl}
			type="button"
			aria-current={active ? "true" : undefined}
			data-drop-row={persona.id}
			data-drop-team={team ?? ""}
			draggable={draggable && !phone}
			onDragStart={onDragStartRow}
			onDragOver={onDragOverRow}
			onDrop={onDropRow}
			onDragEnd={onDragEndRow}
			onClick={() => {
				if (pressFired.current) {
					pressFired.current = false;
					return;
				}
				onSelect();
			}}
			onContextMenu={(e) => {
				e.preventDefault();
				onSelect();
				onMenu(e);
			}}
			onTouchStart={onTouchStart}
			onTouchMove={onTouchMove}
			onTouchEnd={cancelPress}
			onTouchCancel={cancelPress}
			className={`rail-row ${active ? "rail-row-on" : ""} ${lifted ? "rail-row-lifted" : ""} ${
				dropBefore ? "rail-row-drop" : ""
			}`}
		>
			{persona.face ? (
				<span className="face" aria-hidden="true">
					<FaceIcon face={persona.face} size={webClient() ? 44 : 30} />
				</span>
			) : (
				<span className="face" style={{ background: faceOf(persona.id) }} aria-hidden="true">
					{initialOf(persona.name)}
				</span>
			)}

			<span className="min-w-0 flex-1">
				<span className="flex items-center gap-2xs">
					<span
						className={`truncate text-md font-medium ${active ? "text-ink" : "text-ink-2"}`}
					>
						{persona.name}
					</span>
					{when && <span className="ml-auto shrink-0 pl-2xs text-2xs text-ink-3">{when}</span>}
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

				{/* What was last said, or the next scheduled run when that is the
				    news — one line either way, so the rows stay a uniform height.
				    The schedule is this line, not a third dot beside the vital. */}
				<span className={`block truncate text-sm ${phone && busy ? "text-accent-dim" : "text-ink-3"}`}>
					{phone && busy
						? "working…"
						: jobs[0]
							? jobLine(jobs[0])
							: preview
								? `${preview.from === "me" ? "you: " : ""}${plainOf(preview.text)}`
								: vital.label}
				</span>
			</span>

			{shortcut && shortcutLabel(String(shortcut)) && (
				<span aria-hidden="true" className="shrink-0 font-mono text-2xs text-ink-3">
					{shortcutLabel(String(shortcut))}
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
