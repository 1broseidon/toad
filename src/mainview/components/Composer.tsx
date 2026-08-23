import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { isWorking } from "../../shared/session";
import type { Attachment, SessionInfo, SlashCommand } from "../../shared/types";
import type { Activity } from "../useActivity";
import type { Draft } from "../useToad";
import { ingest, ingestClipboardImage, ingestFiles, looksLikePaths } from "../attachments";
import { shortcutLabel, webClient } from "../platform";
import { api } from "../rpc";
import { Glyph } from "./Glyph";
import { ClipIcon, CloseIcon, SendIcon, StopIcon } from "./icons";

type Props = {
	personaId: string;
	info: SessionInfo;
	activity: Activity;
	draft: Draft;
	onDraftChange(next: Draft): void;
	onAttach(added: Attachment[]): void;
	onSend(text: string, attachments: Attachment[]): void;
	onSteer(text: string, attachments: Attachment[]): void;
	onCancel(): void;
};

/** The field stops growing here, and scrolls from then on. */
const MAX_HEIGHT = 200;

/**
 * The composer floats over the foot of the transcript rather than sitting in a
 * bar of its own. Nothing else in the app is raised off the page, which is what
 * makes the one raised thing read as the place you type.
 *
 * What is being written belongs to the teammate it is being written to, so the
 * text and its attachments live above this component and arrive as a `draft`.
 * Switching conversations then puts down one message and picks up another,
 * which is what switching conversations means everywhere else.
 */
export function Composer({
	personaId,
	info,
	activity,
	draft,
	onDraftChange,
	onAttach,
	onSend,
	onSteer,
	onCancel,
}: Props) {
	const [grown, setGrown] = useState(false);
	const area = useRef<HTMLTextAreaElement>(null);
	/* The phone's file input, clicked by the paperclip. */
	const filePick = useRef<HTMLInputElement>(null);
	const working = isWorking(info.state);
	const { text, attachments } = draft;

	const setText = (next: string) => onDraftChange({ ...draft, text: next });

	// Grow with content, up to a ceiling. Before paint, because measuring after
	// it means a wrapped line is drawn at the old height for a frame first.
	useLayoutEffect(() => {
		const el = area.current;
		if (!el) return;
		el.style.height = "auto";
		const wanted = el.scrollHeight;
		el.style.height = `${Math.min(wanted, MAX_HEIGHT)}px`;
		// One line's worth of slack, so a full line does not trip the second row.
		setGrown(wanted > 34);
	}, [text, personaId]);

	const matches = slashMatches(text, info.slashCommands);
	const [cursor, setCursor] = useState(0);
	// A menu that reopens on the next keystroke would fight anyone who dismissed
	// it, so Escape only closes what is on screen now.
	const [dismissed, setDismissed] = useState("");
	const menu = matches.length > 0 && dismissed !== text ? matches : [];

	useEffect(() => setCursor(0), [text]);

	const hasContent = text.trim().length > 0 || attachments.length > 0;

	/**
	 * Sending is always live, working or not — a turn only ever decides
	 * whether this becomes a follow-up or, with `steer`, a redirect.
	 */
	const submit = (steer = false) => {
		const trimmed = text.trim();
		if (!trimmed && attachments.length === 0) return;
		if (steer) onSteer(trimmed, attachments);
		else onSend(trimmed, attachments);
	};

	const accept = (command: SlashCommand) => {
		setText(`/${command.name} `);
		area.current?.focus();
	};

	// -- attachments --------------------------------------------------------

	const drop = (path: string) =>
		onDraftChange({ ...draft, attachments: attachments.filter((a) => a.path !== path) });

	/* When the last paste event arrived, so the Ctrl+V fallback below can tell
	 * "the webview handled it" from "the webview never saw it". */
	const pastedAt = useRef(0);

	/**
	 * A paste is a path, a file, text, or an image, and only the text belongs
	 * in the field. Intercepting is decided before anything is read from disk,
	 * so a paste that turns out to name nothing real is put back as the text it
	 * was rather than vanishing.
	 */
	const onPaste = async (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
		pastedAt.current = performance.now();
		const transfer = event.clipboardData;
		if (!looksLikePaths(transfer)) {
			/* No files, no paths — and no text means the default paste would
			 * insert nothing. WebKitGTK lands an image-only clipboard here with
			 * the bytes withheld, so they are fetched natively instead. */
			if (!transfer.getData("text/plain")) {
				event.preventDefault();
				onAttach(await ingestClipboardImage(personaId));
			}
			return;
		}
		const text = transfer.getData("text/plain");
		event.preventDefault();

		const added = await ingest(personaId, transfer);
		if (added.length > 0) {
			onAttach(added);
			return;
		}
		if (text) insertAtCaret(area.current, text, setText);
	};

	/**
	 * The fallback behind the fallback: WebKitGTK does not always fire a paste
	 * event when the clipboard holds no flavour it can insert. Ctrl+V is heard
	 * directly, given a beat for the real event to arrive, and only when none
	 * does is the native clipboard asked for an image.
	 */
	const onPasteKey = () => {
		// The native clipboard on the other end of the RPC is the desktop's;
		// a phone's paste already arrives through the paste event itself.
		if (webClient()) return;
		const heard = performance.now();
		setTimeout(() => {
			if (pastedAt.current >= heard) return;
			void ingestClipboardImage(personaId).then(onAttach);
		}, 150);
	};

	return (
		// The scrim spans the pane so text fades out beneath the card, but only
		// the card itself takes the pointer — the transcript stays scrollable
		// through the fade.
		// The extra right-hand allowance is the transcript's scroll bar: the card
		// sits outside the scrolling box but is meant to line up with what is in it.
		<div className="composer-scrim composer-inset pointer-events-none absolute inset-x-0 bottom-0 z-raised pb-lg pt-2xl">
			<div className="pointer-events-auto mx-auto w-full max-w-composer">
				{menu.length > 0 && (
					<div className="slash-menu" role="listbox" aria-label="Slash commands">
						{menu.slice(0, 8).map((command, index) => (
							<button
								key={command.name}
								type="button"
								role="option"
								aria-selected={index === cursor}
								// Pointer down, not click: click lands after the field has
								// already lost focus, and the caret should never leave it.
								onMouseDown={(e) => {
									e.preventDefault();
									accept(command);
								}}
								onMouseMove={() => setCursor(index)}
								className={`slash-option ${index === cursor ? "is-cursor" : ""}`}
							>
								<span className="shrink-0 font-mono text-xs text-accent">/{command.name}</span>
								<span className="truncate text-2xs text-ink-3">{command.description}</span>
							</button>
						))}
					</div>
				)}

				{/* Present only while something is happening. The row being there at
				    all is the signal you read from across the room, and a mark idling
				    in the same slot spends that on nothing. */}
				{activity.phase !== "idle" && (
					<div className="composer-activity" role="status" aria-label={activity.word}>
						<Glyph phase={activity.phase} />
						<span className="composer-word" aria-hidden="true">
							{activity.word}
						</span>
					</div>
				)}

				<div className="composer-card">
					{attachments.length > 0 && (
						<ul className="chip-tray">
							{attachments.map((item) => (
								<li key={item.path} className="chip" title={item.path}>
									<span className="chip-name">{item.name}</span>
									{item.size !== undefined && (
										<span className="chip-size">{sizeText(item.size)}</span>
									)}
									<button
										type="button"
										className="chip-drop"
										aria-label={`Remove ${item.name}`}
										onClick={() => drop(item.path)}
									>
										<CloseIcon />
									</button>
								</li>
							))}
						</ul>
					)}

					<div className="composer-row">
						{/* The desktop's picker is a native dialog over there; the phone's
						    is its own photo library and Files app, and the bytes ride up
						    over the wire. */}
						<button
							type="button"
							className="attach"
							aria-label="Attach files"
							title="Attach files"
							onClick={() => {
								if (webClient()) filePick.current?.click();
								else void api.pickAttachments(personaId).then(onAttach);
							}}
						>
							<ClipIcon />
						</button>
						{webClient() && (
							<input
								ref={filePick}
								type="file"
								multiple
								hidden
								onChange={(event) => {
									const files = Array.from(event.currentTarget.files ?? []);
									event.currentTarget.value = "";
									if (files.length === 0) return;
									void ingestFiles(personaId, files).then(onAttach);
								}}
							/>
						)}

						<textarea
							ref={area}
							rows={1}
							value={text}
							aria-label="Message your teammate"
							enterKeyHint="send"
							placeholder="Message"
							onChange={(e) => setText(e.target.value)}
							onPaste={(e) => void onPaste(e)}
							onKeyDown={(e) => {
								if (e.key === "v" && e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
									onPasteKey();
								}
								// The menu takes the keys it needs and passes on the rest, so
								// typing never has to stop for it.
								if (menu.length > 0) {
									if (e.key === "ArrowDown" || (e.key === "Tab" && !e.shiftKey)) {
										e.preventDefault();
										setCursor((n) => (n + 1) % menu.length);
										return;
									}
									if (e.key === "ArrowUp" || (e.key === "Tab" && e.shiftKey)) {
										e.preventDefault();
										setCursor((n) => (n - 1 + menu.length) % menu.length);
										return;
									}
								if (e.key === "Enter" && !e.shiftKey) {
									e.preventDefault();
									accept(menu[cursor] ?? menu[0]!);
									return;
								}
								if (e.key === "Escape") {
									e.preventDefault();
									setDismissed(text);
									return;
								}
							}

							if (e.key === "Enter" && !e.shiftKey) {
								e.preventDefault();
								// Held while a turn is running, the modifier means "no, stop
								// — this instead": cancel it and send this one right away.
								submit(working && (e.metaKey || e.ctrlKey));
							}
							// Interrupting with nothing to say is still just Escape,
							// regardless of what is sitting half-written in the field.
							if (e.key === "Escape" && working) {
								e.preventDefault();
								onCancel();
							}
						}}
							className={`composer-field ${grown ? "grown" : ""}`}
						/>

						{working && !hasContent ? (
							<button
								type="button"
								className="send send-stop"
								aria-label="Interrupt this turn"
								title="Interrupt (Esc)"
								onClick={onCancel}
							>
								<StopIcon />
							</button>
						) : (
							<button
								type="button"
								className="send send-go"
								aria-label="Send message"
								title={
									working
										? `Send after this turn (Enter) · Send now (${shortcutLabel("Enter")})`
										: "Send (Enter)"
								}
								disabled={!hasContent}
								onClick={() => submit(false)}
							>
								<SendIcon />
							</button>
						)}
					</div>
				</div>
			</div>
		</div>
	);
}

function slashMatches(value: string, commands: SlashCommand[]): SlashCommand[] {
	if (!value.startsWith("/") || value.includes(" ")) return [];
	const query = value.slice(1).toLowerCase();
	return commands.filter((c) => c.name.toLowerCase().startsWith(query));
}

/**
 * Puts text back where the caret was, for a paste that was intercepted and then
 * turned out not to name a file. The selection is restored too, so the only
 * trace of the detour is that it took a round trip to find out.
 */
function insertAtCaret(
	area: HTMLTextAreaElement | null,
	text: string,
	setText: (next: string) => void,
): void {
	if (!area) return;
	const { value, selectionStart, selectionEnd } = area;
	const at = selectionStart + text.length;
	setText(value.slice(0, selectionStart) + text + value.slice(selectionEnd));
	requestAnimationFrame(() => area.setSelectionRange(at, at));
}

function sizeText(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	const kb = bytes / 1024;
	return kb < 1024 ? `${Math.round(kb)} KB` : `${(kb / 1024).toFixed(1)} MB`;
}
