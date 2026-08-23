import { useRef, type MouseEvent, type ReactNode, type TouchEvent } from "react";
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
import { timeAgoShort } from "../messages";
import { plainOf } from "../messages";
import { shortcutLabel, webClient } from "../platform";
import { FaceIcon } from "./FaceIcon";
import { RailShell } from "./RailShell";
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
	onAddingChange(adding: boolean): void;
	onScrollEdge(scrolled: boolean): void;
	onSelect(id: string): void;
	onOpenAppSettings(): void;
	onPersonaMenu(personaId: string, event: MouseEvent): void;
};

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
	onAddingChange,
	onScrollEdge,
	onSelect,
	onOpenAppSettings,
	onPersonaMenu,
}: Props) {
	const working = personas.filter((p) => {
		const state = sessions[p.id]?.state;
		return state !== undefined && isBusy(state);
	}).length;

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

			{personas.map((persona, index) => (
				<Row
					key={persona.id}
					persona={persona}
					state={sessions[persona.id]?.state ?? "idle"}
					preview={previews[persona.id]}
					peer={peerActivity[persona.id]}
					jobs={schedules[persona.id] ?? []}
					/* The roster's first nine are on ⌘1–⌘9, so the row says so — the
					   shortcut is no use to anyone who has to go looking for it. */
					shortcut={index < 9 ? index + 1 : null}
					active={persona.id === selectedId}
					onSelect={() => onSelect(persona.id)}
					onMenu={(event) => onPersonaMenu(persona.id, event)}
				/>
			))}
		</RailShell>
	);
}

function Row({
	persona,
	state,
	preview,
	peer,
	jobs,
	shortcut,
	active,
	onSelect,
	onMenu,
}: {
	persona: Persona;
	state: SessionState;
	preview?: Preview;
	peer?: PeerActivity;
	jobs: ScheduledJob[];
	shortcut: number | null;
	active: boolean;
	onSelect(): void;
	onMenu(event: MouseEvent): void;
}) {
	const vital = VITAL[state];
	/* iOS never fires `contextmenu`, so the row watches the touch itself: held
	 * still for a beat, it is the platform's right-click and opens the menu;
	 * moved, it is a scroll and nothing happens. The click that follows a
	 * long-press is swallowed, or the menu would push the conversation too. */
	const press = useRef<{ x: number; y: number; timer: number } | null>(null);
	const pressFired = useRef(false);
	const cancelPress = () => {
		if (press.current) window.clearTimeout(press.current.timer);
		press.current = null;
	};
	const onTouchStart = (event: TouchEvent) => {
		const touch = event.touches[0];
		if (!touch || event.touches.length > 1) return;
		cancelPress();
		pressFired.current = false;
		const { clientX, clientY } = touch;
		press.current = {
			x: clientX,
			y: clientY,
			timer: window.setTimeout(() => {
				press.current = null;
				pressFired.current = true;
				onMenu({ clientX, clientY, preventDefault() {} } as unknown as MouseEvent);
			}, 450),
		};
	};
	const onTouchMove = (event: TouchEvent) => {
		const touch = event.touches[0];
		if (!press.current || !touch) return;
		if (Math.hypot(touch.clientX - press.current.x, touch.clientY - press.current.y) > 10) {
			cancelPress();
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
			type="button"
			aria-current={active ? "true" : undefined}
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
			className={`rail-row ${active ? "rail-row-on" : ""}`}
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
