import { type DragEvent as ReactDragEvent, useEffect, useRef, useState } from "react";
import { ChatHeader } from "./components/ChatHeader";
import { Composer } from "./components/Composer";
import { PeerThreadViewer } from "./components/PeerThreadViewer";
import { Sidebar } from "./components/Sidebar";
import {
	curveOf,
	type IdentityDraft,
	SettingsOverlay,
} from "./components/settings/SettingsOverlay";
import {
	type AppSectionId,
	DEFAULT_APP_SECTION,
	DEFAULT_TEAMMATE_SECTION,
	isAppSection,
	isTeammateSection,
	type SettingsRoute,
	type TeammateSectionId,
} from "./components/settings/sections";
import { Toolbar } from "./components/Toolbar";
import { Transcript } from "./components/Transcript";
import { ingest } from "./attachments";
import { on } from "./rpc";
import { useActivity } from "./useActivity";
import { useMedia } from "./useMedia";
import { usePeerThreads } from "./usePeerThreads";
import { useToad } from "./useToad";

/**
 * Below this the three panes cannot all be on screen and still leave a
 * conversation worth reading, so the roster folds away and slides back over the
 * chat on demand. It matches the width at which `--gutter` opens up, which is
 * the same judgement about when the window has room to spare.
 */
const NARROW = "(max-width: 47.999rem)";

export default function App() {
	const toad = useToad();
	const peers = usePeerThreads(toad.selectedId);
	const [settings, setSettings] = useState<SettingsRoute | null>(null);
	/* Where you were, per scope, so reopening returns you there rather than to
	 * the top of a list you have already read. Per window run only. */
	const lastSection = useRef<{ teammate: TeammateSectionId; app: AppSectionId }>({
		teammate: DEFAULT_TEAMMATE_SECTION,
		app: DEFAULT_APP_SECTION,
	});
	/* Identity edits that were never saved, kept by teammate. Held here rather
	 * than in the section so that leaving the section — or leaving settings —
	 * does not throw away typing that was not finished. */
	const [identityDrafts, setIdentityDrafts] = useState<Record<string, IdentityDraft>>({});
	const [adding, setAdding] = useState(false);
	// Bumped when a menu asks to rename, so the settings panel takes the caret.
	const [renameNonce, setRenameNonce] = useState(0);

	const narrow = useMedia(NARROW);
	const [railOpen, setRailOpen] = useState(false);
	const showRail = !narrow || railOpen;

	// Both toolbar segments share one hairline, so it lights across the whole
	// window rather than under whichever pane happens to have scrolled.
	const [railScrolled, setRailScrolled] = useState(false);
	const [paneScrolled, setPaneScrolled] = useState(false);
	const scrolled = railScrolled || paneScrolled;

	const { selected, sessionInfo } = toad;

	const openSettings = (scope: "teammate" | "app", section?: string) => {
		if (scope === "teammate" && selected === null) return;
		setRailOpen(false);
		if (scope === "teammate") {
			const next =
				section && isTeammateSection(section)
					? section
					: isTeammateSection(lastSection.current.teammate)
						? lastSection.current.teammate
						: DEFAULT_TEAMMATE_SECTION;
			lastSection.current.teammate = next;
			setSettings({ scope, section: next });
			return;
		}
		const next =
			section && isAppSection(section)
				? section
				: isAppSection(lastSection.current.app)
					? lastSection.current.app
					: DEFAULT_APP_SECTION;
		lastSection.current.app = next;
		setSettings({ scope, section: next });
	};
	const closeSettings = () => {
		setSettings(null);
		if (narrow && selected === null) setRailOpen(true);
	};

	/* What the teammate is doing, raised above the composer. It is derived here
	 * rather than inside the composer because it takes the transcript and the
	 * live token stream as well as the session's own state, and the composer
	 * should not have to know about any of that to draw one indicator. */
	const [pacing, setPacing] = useState(false);
	const activity = useActivity(toad.selectedId, sessionInfo, toad.transcript, pacing);

	/* Dropping a file on a conversation attaches it, and the whole pane is the
	 * target — the composer is where the message is written, but the window is
	 * what you are dragging at. Enter and leave fire again for every child the
	 * cursor crosses, so the depth is counted rather than toggled. */
	const [dragging, setDragging] = useState(false);
	const dragDepth = useRef(0);

	const onDrop = (event: ReactDragEvent) => {
		event.preventDefault();
		dragDepth.current = 0;
		setDragging(false);
		if (!selected) return;
		const id = selected.id;
		void ingest(id, event.dataTransfer).then((added) => toad.addAttachments(id, added));
	};

	/* Only the roster lifts over the conversation, now that settings cover it
	 * outright rather than sitting beside it. */
	const overlaid = narrow && railOpen;
	const dismiss = () => setRailOpen(false);

	/* With nothing selected there is no conversation to cover, so the roster is
	 * the only thing worth showing — and it is where you would go next anyway. */
	useEffect(() => {
		if (narrow && !toad.selectedId) setRailOpen(true);
	}, [narrow, toad.selectedId]);

	/* Widening the window puts the rail back into the layout; a drawer left open
	 * would otherwise linger on top of the copy of itself. */
	useEffect(() => {
		if (!narrow) setRailOpen(false);
	}, [narrow]);

	/* Settings sections are peers, not a stack: Escape leaves settings outright.
	 * Without settings, it still dismisses a roster laid over a conversation. */
	useEffect(() => {
		const covered = peers.openKey !== null || settings !== null || (overlaid && selected !== null);
		if (!covered) return;
		const close = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return;
			if (peers.openKey) peers.close();
			else if (settings) closeSettings();
			else dismiss();
		};
		window.addEventListener("keydown", close);
		return () => window.removeEventListener("keydown", close);
	}, [peers.openKey, peers.close, settings, overlaid, selected]);

	// This is a window, not a page: right-clicking chrome should not offer
	// Reload and Inspect Element. Editable fields and live selections keep
	// WebKit's own menu, which is the real Cut/Copy/Paste/Look Up one.
	useEffect(() => {
		const suppress = (event: MouseEvent) => {
			const target = event.target as HTMLElement | null;
			if (target?.closest("input, textarea")) return;
			if (window.getSelection()?.isCollapsed === false) return;
			event.preventDefault();
		};
		document.addEventListener("contextmenu", suppress);
		return () => document.removeEventListener("contextmenu", suppress);
	}, []);

	// The native menu bar and the right-click menus name an intent and stop
	// there. Every one of them lands here, on the same paths the buttons use.
	useEffect(
		() =>
			on("menuAction", ({ action, personaId }) => {
				const id = personaId ?? toad.selectedId;

				switch (action) {
					case "newTeammate":
						setAdding(true);
						return;
					case "settings":
						openSettings("teammate");
						return;
					case "appSettings":
						openSettings("app");
						return;
					// Choosing a teammate means going to its conversation, so anything
					// covering that conversation gets out of the way.
					case "selectTeammate":
						if (id) toad.setSelectedId(id);
						setRailOpen(false);
						closeSettings();
						return;
					case "startSession":
						if (id) void toad.startSession(id);
						return;
					case "stopSession":
						if (id) void toad.stopSession(id);
						return;
					case "cancelTurn":
						if (id) void toad.cancel(id);
						return;
					case "revealWorkspace":
						if (id) void toad.revealWorkspace(id);
						return;
					// Rename has one home — the name field in the inspector.
					case "renameTeammate":
						if (!id) return;
						toad.setSelectedId(id);
						openSettings("teammate", "identity");
						setRenameNonce((n) => n + 1);
						return;
					case "deleteTeammate":
						if (!id) return;
						void toad.removePersona(id).then((deleted) => {
							if (!deleted) return;
							setIdentityDrafts((current) => {
								const { [id]: _gone, ...rest } = current;
								return rest;
							});
							closeSettings();
						});
						return;
				}
			}),
		[toad],
	);

	return (
		// Positioned, because the roster is lifted out of the flow when it becomes
		// a drawer and has to be placed against this box rather than the window.
		//
		// The shell is the roster's surface rather than the page's, so it is what
		// shows through the notch where the conversation's corners curve away.
		<div className="relative flex h-full w-full overflow-hidden bg-paper-2">
			{showRail && (
				<Sidebar
					personas={toad.personas}
					backends={toad.backends}
					sessions={toad.sessions}
					previews={toad.previews}
					peerActivity={peers.activity}
					selectedId={toad.selectedId}
					adding={adding}
					scrolled={scrolled}
					drawer={narrow}
					onAddingChange={setAdding}
					onScrollEdge={setRailScrolled}
					onSelect={(id) => {
						toad.setSelectedId(id);
						// Picking someone is the reason the drawer was opened.
						setRailOpen(false);
						closeSettings();
					}}
					onCreate={(name, backendId) => toad.createPersona(name, backendId)}
					onOpenAppSettings={() => openSettings("app")}
				/>
			)}

			{/* Dismissing an overlaid pane by pressing the conversation it covers. */}
			{overlaid && selected && (
				<button
					type="button"
					aria-label="Back to the conversation"
					className="scrim animate-fade-in"
					onClick={dismiss}
				/>
			)}

			{!selected || !sessionInfo ? (
				<EmptyState ready={toad.ready} lights={narrow && !railOpen} curve={curveOf(narrow)} />
			) : (
				<>
					{/* Positioned, because the composer floats over this pane's foot and
					    the teammate's settings cover it. */}
					<main
						className={`relative flex min-w-0 flex-1 flex-col bg-paper ${curveOf(narrow)}`}
						onDragEnter={(event) => {
							if (!hasFiles(event)) return;
							dragDepth.current += 1;
							setDragging(true);
						}}
						onDragOver={(event) => {
							// Without this the window refuses the drop and macOS animates
							// the file back to where it came from.
							if (hasFiles(event)) event.preventDefault();
						}}
						onDragLeave={() => {
							dragDepth.current = Math.max(0, dragDepth.current - 1);
							if (dragDepth.current === 0) setDragging(false);
						}}
						onDrop={onDrop}
					>
						<ChatHeader
							persona={selected}
							backend={toad.backends.find((b) => b.id === selected.backendId)}
							info={sessionInfo}
							threads={peers.threads}
							scrolled={scrolled}
							settingsActive={settings?.scope === "teammate"}
							onOpenRail={
								narrow
									? () => {
											closeSettings();
											setRailOpen(true);
										}
									: undefined
							}
							onStart={() => void toad.startSession(selected.id)}
							onSetModel={(modelId) => void toad.setModel(selected.id, modelId)}
							onSetMode={(modeId) => void toad.setMode(selected.id, modeId)}
							onOpenPeerThread={peers.open}
							onToggleSettings={() => openSettings("teammate")}
						/>

						{/* Keyed per teammate so switching resets scroll pinning and so a
						    replayed transcript is treated as history, not as new arrivals. */}
						<Transcript
							key={selected.id}
							events={toad.transcript}
							working={sessionInfo.state === "thinking"}
							onScrollEdge={setPaneScrolled}
							onPacing={setPacing}
							onOpenPeerThread={peers.open}
							onAnswerPermission={(requestId, optionId) =>
								void toad.answerPermission(selected.id, requestId, optionId)
							}
						/>

						<Composer
							personaId={selected.id}
							info={sessionInfo}
							activity={activity}
							draft={toad.draft}
							onDraftChange={(next) => toad.setDraft(selected.id, next)}
							onAttach={(added) => toad.addAttachments(selected.id, added)}
							onSend={(text, attachments) => void toad.send(selected.id, text, attachments)}
							onCancel={() => void toad.cancel(selected.id)}
						/>

						{dragging && (
							<div className="drop-veil" aria-hidden="true">
								<p className="drop-note">Drop to attach</p>
							</div>
						)}

					</main>
				</>
			)}

			{/* Settings own a rail, so they cover the roster and conversation as one
			    window rather than leaving two rails side by side. */}
			{settings && (
				<SettingsOverlay
					route={settings}
					narrow={narrow}
					persona={selected}
					backends={toad.backends}
					info={sessionInfo}
					renameNonce={renameNonce}
					identityDraft={selected ? identityDrafts[selected.id] : undefined}
					onIdentityDraftChange={(personaId, draft) =>
						setIdentityDrafts((current) => {
							if (draft) return { ...current, [personaId]: draft };
							const { [personaId]: _gone, ...rest } = current;
							return rest;
						})
					}
					onRoute={(route) => {
						if (route.scope === "teammate") lastSection.current.teammate = route.section;
						else lastSection.current.app = route.section;
						setSettings(route);
					}}
					onClose={closeSettings}
					onPatchPersona={(patch) =>
						selected ? toad.patchPersona(selected.id, patch) : Promise.resolve(null)
					}
					onDeletePersona={() => {
						if (!selected) return;
						const id = selected.id;
						void toad.removePersona(id).then((deleted) => {
							if (!deleted) return;
							setIdentityDrafts((current) => {
								const { [id]: _gone, ...rest } = current;
								return rest;
							});
							closeSettings();
						});
					}}
					onPickWorkspace={() => toad.pickWorkspace(selected?.cwd)}
					onRevealWorkspace={() => {
						if (selected) void toad.revealWorkspace(selected.id);
					}}
					onRefreshBackends={toad.refreshBackends}
				/>
			)}

			{peers.openKey && (
				<PeerThreadViewer
					thread={peers.thread}
					onAnswerPermission={(requestId, optionId) =>
						void peers.answerPermission(requestId, optionId)
					}
					onClose={peers.close}
				/>
			)}
		</div>
	);
}

/**
 * Whether a drag is carrying files rather than a selection of text.
 *
 * Dragging a word out of one message and into another is a thing people do,
 * and it should stay a text drop.
 */
const hasFiles = (event: ReactDragEvent): boolean =>
	Array.from(event.dataTransfer.types).includes("Files");

/** `lights` when this pane holds the window's corner, and so the traffic lights. */
function EmptyState({
	ready,
	lights,
	curve,
}: {
	ready: boolean;
	lights: boolean;
	curve: string;
}) {
	return (
		<main className={`flex min-w-0 flex-1 flex-col bg-paper ${curve}`}>
			{/* The toolbar band runs the width of the window even with nothing in
			    it, so the traffic lights never sit on a seam. */}
			<Toolbar className={lights ? "pl-lights" : ""} />
			<div className="flex flex-1 items-center justify-center px-gutter pb-2xl">
				<div className="max-w-[26rem]">
					<h2 className="text-xl text-ink">{ready ? "No teammate selected" : "Loading…"}</h2>
					{ready && (
						<p className="mt-xs text-sm leading-relaxed text-ink-3">
							Add a teammate with the + button, or press ⌘N. Each one is a persistent agent with
							its own identity, its own working directory, and its own conversation — and you
							talk to it the way you would talk to anyone else.
						</p>
					)}
				</div>
			</div>
		</main>
	);
}
