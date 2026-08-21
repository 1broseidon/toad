import { type MouseEvent as ReactMouseEvent, useEffect, useMemo, useRef, useState } from "react";
import type { Attachment, PermissionOption, TranscriptEvent } from "../../shared/types";
import { api } from "../rpc";
import { splitMessage } from "../messages";
import { Markdown } from "./Markdown";

type Props = {
	events: TranscriptEvent[];
	/** True while a turn is running, which is what holds a reply open. */
	working: boolean;
	variant?: "chat" | "peer";
	/**
	 * Names for the two sides, when neither of them is the reader.
	 *
	 * Your own chat needs none of this: the right-hand side is you. A thread
	 * between two teammates has to name both, or the layout implies a "you" who
	 * never spoke.
	 */
	speakers?: { me: string; them: string };
	onAnswerPermission(requestId: string, optionId: string): void;
	/** Answers a hand-to-human card. Absent in peer threads, which have no human. */
	onAnswerHumanAction?(actionId: string, status: "done" | "dismissed"): void;
	/** Opens the teammate's computer screen; present only when it has one. */
	onOpenComputer?(): void;
	onScrollEdge(scrolled: boolean): void;
	/**
	 * Whether a reply is being held back between the bubbles Toad invented for
	 * it. The working indicator lives above the composer now, and this is the one
	 * part of "still coming" that only the transcript can know about.
	 */
	onPacing(pacing: boolean): void;
	onOpenPeerThread?(threadKey: string): void;
	onMessageMenu?(text: string, event: ReactMouseEvent): void;
};

/**
 * The conversation, drawn the way a messages app draws one.
 *
 * A teammate is someone you talk to, so what belongs on screen is what it
 * actually said. Thinking, tool calls, and plans are how it got there — they
 * are the machinery, and they are left out. While the machinery runs, the
 * indicator above the composer says so, and then the message lands. What does
 * stay is anything the conversation cannot continue without: a permission
 * request, and anything that went wrong.
 */
export function Transcript({
	events,
	working,
	variant = "chat",
	speakers,
	onAnswerPermission,
	onAnswerHumanAction,
	onOpenComputer,
	onScrollEdge,
	onPacing,
	onOpenPeerThread,
	onMessageMenu,
}: Props) {
	const beats = useMemo(() => beatsFrom(events), [events]);

	// Anything written before this component existed is history and lands at
	// once. Only what the agent says from here on gets paced.
	const mountedAt = useRef(Date.now());
	const isNew = (beat: Beat) => beat.at > mountedAt.current;

	const [revealed, setRevealed] = useState(beats.length);

	useEffect(() => {
		if (variant === "peer") return;
		if (revealed >= beats.length) return;

		let historyEnd = revealed;
		while (historyEnd < beats.length && !isNew(beats[historyEnd]!)) historyEnd++;
		if (historyEnd > revealed) {
			setRevealed(historyEnd);
			return;
		}

		const timer = setTimeout(() => setRevealed((n) => n + 1), pace(beats, revealed));
		return () => clearTimeout(timer);
	}, [revealed, beats, variant]);

	const shown = variant === "peer" ? beats : beats.slice(0, revealed);
	// The indicator stays up between paced bubbles too, so a reply that arrives
	// in three parts reads as three things being typed rather than three things
	// dropped.
	const pacing = variant === "chat" && revealed < beats.length;
	const typing = working || pacing;

	useEffect(() => {
		onPacing(pacing);
	}, [pacing, onPacing]);

	// Switching teammates tears this down mid-pace; the indicator above the
	// composer belongs to whoever is on screen now, not to who just left.
	useEffect(() => {
		return () => onPacing(false);
	}, [onPacing]);

	const scroller = useRef<HTMLDivElement>(null);
	const pinned = useRef(true);
	const edge = useRef(false);

	useEffect(() => {
		const el = scroller.current;
		if (!el) return;
		const onScroll = () => {
			pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
			// Only report the crossing, so the toolbar does not re-render per frame.
			const scrolled = el.scrollTop > 0;
			if (scrolled !== edge.current) {
				edge.current = scrolled;
				onScrollEdge(scrolled);
			}
		};
		el.addEventListener("scroll", onScroll, { passive: true });
		return () => el.removeEventListener("scroll", onScroll);
	}, [onScrollEdge]);

	useEffect(() => {
		// Scroll the container rather than the last row into view: the column's
		// bottom padding is what holds the conversation clear of the floating
		// composer, and only scrollHeight counts it.
		const el = scroller.current;
		if (el && pinned.current) el.scrollTop = el.scrollHeight;
	}, [revealed, typing]);

	// Right-clicking a message hands its text to whoever owns the menu — the
	// native one where Electrobun has one, the HTML one on Linux.
	const openMessageMenu = (event: ReactMouseEvent) => {
		const row = (event.target as HTMLElement).closest<HTMLElement>("[data-copy]");
		if (!row?.dataset.copy) return;
		event.preventDefault();
		if (onMessageMenu) onMessageMenu(row.dataset.copy, event);
		else void api.showMessageMenu(row.dataset.copy);
	};

	if (beats.length === 0 && !typing) {
		return (
			<div className="flex flex-1 items-center justify-center px-gutter pb-composer">
				<p className="max-w-[24rem] text-center text-sm leading-relaxed text-ink-3">
					No messages yet. Say something to get started.
				</p>
			</div>
		);
	}

	/* Positioned so the veil can be pinned to the top of the viewport rather than
	 * to the top of the pane: the header above this is not a fixed height — an
	 * error callout can push it down — and a fade at the wrong offset is worse
	 * than no fade at all. */
	return (
		<div className="relative flex min-h-0 flex-1 flex-col">
			<div
				ref={scroller}
				className="scroll-steady flex-1 overflow-y-auto"
				onContextMenu={openMessageMenu}
			>
				{/* The gutter is the window's clearance and sits outside the column, so
				    that a bubble's edge and the composer's edge are the same edge.
				    `justify-end` rests a short conversation on the composer instead of
				    stranding it at the top. */}
				<div className="flex min-h-full flex-col justify-end px-gutter pb-composer pt-lg">
					<div className="mx-auto flex w-full max-w-composer flex-col">
						{shown.map((beat, index) => {
							const previous = shown[index - 1];
							const stamp = previous === undefined || beat.at - previous.at > STAMP_AFTER;
							// Runs are what give a conversation its rhythm: bubbles from one
							// speaker close together, and real air where the speaker changes.
							const startsRun = stamp || !sameRun(previous, beat);

							return (
								<div
									key={beat.id}
									className={stamp ? "" : startsRun ? "mt-md first:mt-0" : "bubble-run"}
								>
									{stamp && <p className="stamp">{stampText(beat.at)}</p>}
									{speakers && startsRun && beat.kind === "say" && (
										<p className={`speaker ${beat.from === "me" ? "speaker-me" : ""}`}>
											{beat.from === "me" ? speakers.me : speakers.them}
										</p>
									)}
									<Row
										beat={beat}
										fresh={variant === "chat" && isNew(beat)}
										onAnswerPermission={onAnswerPermission}
										onAnswerHumanAction={onAnswerHumanAction}
										onOpenComputer={onOpenComputer}
										onOpenPeerThread={onOpenPeerThread}
									/>
								</div>
							);
						})}
					</div>
				</div>
			</div>

			<div className="transcript-veil" aria-hidden="true" />
		</div>
	);
}

function Row({
	beat,
	fresh,
	onAnswerPermission,
	onAnswerHumanAction,
	onOpenComputer,
	onOpenPeerThread,
}: {
	beat: Beat;
	fresh: boolean;
	onAnswerPermission(requestId: string, optionId: string): void;
	onAnswerHumanAction?(actionId: string, status: "done" | "dismissed"): void;
	onOpenComputer?(): void;
	onOpenPeerThread?(threadKey: string): void;
}) {
	const entrance = fresh ? "animate-strike" : "";

	if (beat.kind === "note") {
		return (
			<p className={`note ${entrance}`} data-tone={beat.tone}>
				{beat.text}
			</p>
		);
	}

	if (beat.kind === "ask") {
		return (
			<div className={`bubble bubble-them bubble-ask ${entrance}`}>
				<p className="mb-xs">{beat.title}</p>
				<div className="flex flex-wrap gap-xs">
					{beat.options.map((option) => (
						<button
							key={option.optionId}
							type="button"
							onClick={() => onAnswerPermission(beat.requestId, option.optionId)}
							className={option.kind?.startsWith("allow") ? "btn-primary" : "btn-outline"}
						>
							{option.name}
						</button>
					))}
				</div>
			</div>
		);
	}

	if (beat.kind === "frame") {
		const img = (
			<img
				src={beat.dataUrl}
				alt="The computer's screen at capture"
				className="block w-full max-w-sm rounded-md border border-rule"
			/>
		);
		return onOpenComputer ? (
			<button
				type="button"
				className={`block text-left ${entrance}`}
				title="Open the computer"
				onClick={onOpenComputer}
			>
				{img}
			</button>
		) : (
			<div className={entrance}>{img}</div>
		);
	}

	if (beat.kind === "human") {
		return (
			<div className={`bubble bubble-them bubble-ask ${entrance}`}>
				<p className="mb-2xs text-2xs uppercase tracking-wide text-ink-3">needs your hands</p>
				<p className="mb-xs">{beat.reason}</p>
				<div className="flex flex-wrap gap-xs">
					{onOpenComputer && (
						<button type="button" className="btn-primary" onClick={onOpenComputer}>
							Open the computer
						</button>
					)}
					<button
						type="button"
						className="btn-outline"
						onClick={() => onAnswerHumanAction?.(beat.actionId, "done")}
					>
						Done
					</button>
					<button
						type="button"
						className="btn-ghost"
						onClick={() => onAnswerHumanAction?.(beat.actionId, "dismissed")}
					>
						Dismiss
					</button>
				</div>
			</div>
		);
	}

	if (beat.kind === "peer") {
		const text = peerText(beat);
		if (!onOpenPeerThread) {
			return (
				<p className={`note ${entrance}`} data-tone="quiet">
					{text}
				</p>
			);
		}
		return (
			<button
				type="button"
				className={`peer-pill ${entrance}`}
				onClick={() => onOpenPeerThread(beat.threadKey)}
			>
				{text}
			</button>
		);
	}

	const side = beat.from === "me" ? "bubble-me" : "bubble-them";
	return (
		<div
			data-copy={beat.text}
			className={`bubble ${side} ${beat.code ? "bubble-code" : ""} ${entrance}`}
		>
			{beat.attachments && beat.attachments.length > 0 && (
				<ul className="bubble-files">
					{beat.attachments.map((item) => (
						<li key={item.path} className="bubble-file" title={item.path}>
							{item.name}
						</li>
					))}
				</ul>
			)}
			{/* What you typed is shown as you typed it. Formatting your own asterisks
			 * would be the app editing your message on the way out. */}
			{beat.code || beat.from === "me" ? beat.text : <Markdown text={beat.text} />}
		</div>
	);
}

// ---------------------------------------------------------------------------
// Turning a transcript into things that get said
// ---------------------------------------------------------------------------

type Beat =
	/**
	 * `invented` marks a bubble whose boundary Toad made up.
	 *
	 * An agent that writes, calls a tool, then writes again produces two messages
	 * seconds apart, and that spacing is real — it is the time the work took.
	 * Splitting one of those messages on its paragraph breaks produces boundaries
	 * that exist only because Toad put them there, and those are the only ones
	 * that need a delay invented to go with them.
	 */
	| {
			kind: "say";
			id: string;
			at: number;
			from: "me" | "them";
			text: string;
			code: boolean;
			invented: boolean;
			attachments?: Attachment[];
	  }
	| { kind: "ask"; id: string; at: number; requestId: string; title: string; options: PermissionOption[] }
	| { kind: "human"; id: string; at: number; actionId: string; reason: string }
	| { kind: "frame"; id: string; at: number; dataUrl: string }
	| {
			kind: "peer";
			id: string;
			at: number;
			threadKey: string;
			withName: string;
			role: "caller" | "target";
			exchanges: number;
			status: "open" | "done" | "waiting" | "failed";
	  }
	| { kind: "note"; id: string; at: number; tone: "quiet" | "danger"; text: string };

function beatsFrom(events: TranscriptEvent[]): Beat[] {
	const beats: Beat[] = [];

	for (const event of events) {
		switch (event.kind) {
			case "user": {
				const text = event.text.trim();
				// A message can be nothing but what was attached to it.
				if (text || event.attachments?.length) {
					beats.push({
						kind: "say",
						id: event.id,
						at: event.ts,
						from: "me",
						text,
						code: false,
						invented: false,
						attachments: event.attachments,
					});
				}
				break;
			}

			case "agent": {
				// One reply, several bubbles — the way a person sends a thought at a
				// time rather than one wall of text. The first lands with the message
				// it came from; the rest are Toad's own breaks and get paced.
				splitMessage(event.text).forEach((piece, index) => {
					beats.push({
						kind: "say",
						id: `${event.id}:${index}`,
						at: event.ts,
						from: "them",
						text: piece.text,
						code: piece.code,
						invented: index > 0,
					});
				});
				break;
			}

			case "permission":
				if (event.decision === undefined) {
					beats.push({
						kind: "ask",
						id: event.id,
						at: event.ts,
						requestId: event.requestId,
						title: event.title,
						options: event.options,
					});
				}
				break;

			// What the agent saw when it looked at its computer. The chat is
			// where the work happens; the frames belong in it.
			case "computer_frame":
				beats.push({
					kind: "frame",
					id: event.id,
					at: event.ts,
					dataUrl: event.dataUrl,
				});
				break;

			// A settled card leaves the conversation the way an answered
			// permission does: the agent's next words carry the outcome.
			case "human_action":
				if (event.status === "pending") {
					beats.push({
						kind: "human",
						id: event.id,
						at: event.ts,
						actionId: event.actionId,
						reason: event.reason,
					});
				}
				break;

			case "notice":
				// The conversation only surfaces failures that interrupted work.
				// Restore fallbacks, clean exits and standing configuration belong
				// in diagnostics/settings, not between two people talking.
				if (event.level !== "error") break;
				beats.push({
					kind: "note",
					id: event.id,
					at: event.ts,
					tone: "danger",
					text: event.text,
				});
				break;

			case "peer":
				beats.push({
					kind: "peer",
					id: event.id,
					at: event.ts,
					threadKey: event.threadKey,
					withName: event.withName,
					role: event.role,
					exchanges: event.exchanges,
					status: event.status,
				});
				break;

			// thought / tool / plan / turn are machinery, and stay off screen.
		}
	}

	return beats;
}

function peerText(beat: Beat & { kind: "peer" }): string {
	if (beat.status === "waiting") return `${beat.withName} is waiting on a permission`;
	if (beat.status === "failed") {
		return beat.role === "caller"
			? `message to ${beat.withName} didn't get through`
			: `message from ${beat.withName} didn't get through`;
	}
	if (beat.exchanges > 1) return `${beat.exchanges} messages with ${beat.withName}`;
	return beat.role === "caller"
		? `sent a message to ${beat.withName}`
		: `${beat.withName} messaged you`;
}

// ---------------------------------------------------------------------------
// Pacing and time
// ---------------------------------------------------------------------------

const REDUCED_MOTION = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

/**
 * How long one invented break is worth holding the dots for.
 *
 * Not real typing speed. A person texting takes several seconds over a sentence,
 * and nobody wants to watch that from something that has already finished
 * writing — this is long enough to read as a second message being composed and
 * short enough that waiting for it never becomes the point.
 */
function typingTime(piece: Beat & { kind: "say" }): number {
	// Code is pasted, not typed: it arrives as an attachment would.
	if (piece.code) return 420;
	const words = piece.text.trim().split(/\s+/).length;
	return Math.min(1_500, 400 + words * 25);
}

/**
 * What a run of invented breaks may spend before the rest land at once.
 *
 * A reply in a dozen parts is already a reply that ignored the house style, and
 * making someone sit through twenty seconds of theatre is not the way to tell
 * them so. Checked before the current break is added rather than after, so the
 * true ceiling is this plus one break — five seconds at worst.
 */
const PACE_BUDGET = 3_500;

/** How long to hold the dots before `beats[index]` lands, in milliseconds. */
function pace(beats: Beat[], index: number): number {
	if (REDUCED_MOTION) return 0;
	const beat = beats[index]!;
	/* Everything else got here on its own schedule: your own message is already
	 * sent, a permission request interrupts whatever was happening, and an
	 * agent's first bubble waited out the work in real time. */
	if (beat.kind !== "say" || !beat.invented) return 0;

	const want = typingTime(beat);
	// What the run of invented breaks before this one has already cost.
	let spent = 0;
	for (let n = index - 1; n >= 0; n--) {
		const earlier = beats[n]!;
		if (earlier.kind !== "say" || !earlier.invented) break;
		spent += typingTime(earlier);
	}
	return spent >= PACE_BUDGET ? 0 : want;
}

/** Long enough that a stamp means "we picked this back up later". */
const STAMP_AFTER = 20 * 60_000;

const sameRun = (a: Beat | undefined, b: Beat | undefined): boolean =>
	!!a &&
	!!b &&
	a.kind === "say" &&
	b.kind === "say" &&
	a.from === b.from &&
	b.at - a.at <= STAMP_AFTER;

const clock = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const weekday = new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric" });

function stampText(at: number): string {
	const when = new Date(at);
	const days = daysBetween(when, new Date());
	if (days === 0) return `Today ${clock.format(when)}`;
	if (days === 1) return `Yesterday ${clock.format(when)}`;
	return `${weekday.format(when)} ${clock.format(when)}`;
}

function daysBetween(a: Date, b: Date): number {
	const midnight = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
	return Math.round((midnight(b) - midnight(a)) / 86_400_000);
}
