import {
	type DragEvent as ReactDragEvent,
	type MouseEvent as ReactMouseEvent,
	type ReactNode,
	useEffect,
	useRef,
	useState,
} from "react";
import type { MenuAction, WindowState } from "../shared/rpc";
import { windowTitle } from "../shared/menu";
import { isUp, isWorking } from "../shared/session";
import { htmlMenuItems } from "./app-menu";
import { ChatHeader } from "./components/ChatHeader";
import { ChromeStrip } from "./components/ChromeStrip";
import { ResizeHandles } from "./components/ResizeHandles";
import { Composer } from "./components/Composer";
import { ComputerDrawer } from "./components/ComputerDrawer";
import { PeerThreadViewer } from "./components/PeerThreadViewer";
import { ThreadsDrawer } from "./components/ThreadsDrawer";
import { SearchDrawer } from "./components/SearchDrawer";
import { PopupMenu, type PopupItem } from "./components/PopupMenu";
import { NewTeammate } from "./components/NewTeammate";
import { Sidebar } from "./components/Sidebar";
import { curveOf, SettingsOverlay } from "./components/settings/SettingsOverlay";
import type { IdentityDraft } from "./components/settings/teammate/Identity";
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
import { InstanceChip } from "./instances/InstanceChip";
import { InstancesScreen } from "./instances/InstancesScreen";
import { LinkInstance } from "./instances/LinkInstance";
import type { LinkedInstance } from "./instances/store";
import { useInstances } from "./instances/useInstances";
import { insetLights, linuxChrome, nativeMenus, nativeShell, shortcutLabel, webClient } from "./platform";
import { api, on, setWebTarget } from "./rpc";
import { useActivity } from "./useActivity";
import { useMedia } from "./useMedia";
import { useEdgeSwipe } from "./useEdgeSwipe";
import { hapticDone } from "./haptics";
import { usePeerThreads } from "./usePeerThreads";
import { useSchedules } from "./useSchedules";
import { useToad } from "./useToad";

/**
 * Below this the three panes cannot all be on screen and still leave a
 * conversation worth reading, so the roster folds away and slides back over the
 * chat on demand. It matches the width at which `--gutter` opens up, which is
 * the same judgement about when the window has room to spare.
 */
const NARROW = "(max-width: 47.999rem)";

/**
 * What this bundle was built from, for the skew note.
 *
 * Nothing defines it at build time for the mainview, so it is written here
 * beside the version in package.json and moves with it. A phone updates on
 * the App Store's schedule and the desktop it talks to updates on its own,
 * so the two drift apart as a matter of course.
 */
const LOCAL_VERSION = "0.2.0";

export default function App() {
	/* Only the phone can be pointed at more than one Toad, so it is the only
	 * shell that has to settle which one before it can draw a roster at all. */
	return nativeShell() ? <NativeApp /> : <Workspace />;
}

/**
 * The app, with the question of which desktop in front of it.
 *
 * The instance list is not a panel over the window — until a desktop is
 * chosen there is no roster, no conversation and no wire to fetch either
 * over, so it stands in for the whole app rather than covering it.
 */
function NativeApp() {
	const instances = useInstances();
	const { active, seen, setStatus, status, unlink } = instances;
	const [switcher, setSwitcher] = useState(false);
	const [linking, setLinking] = useState<{ relinking?: LinkedInstance } | null>(null);
	const [skew, setSkew] = useState<string | null>(null);
	const [lost, setLost] = useState(false);
	/* Which desktop the wire is actually on. Held in state as well as opened,
	 * because the app above must not mount — and start asking for a roster —
	 * against a transport that has not been pointed anywhere yet. */
	const [wired, setWired] = useState<string | null>(null);

	const target = active && active.state === "linked" ? active : null;
	/* The wire depends on these three and nothing else about the row, so
	 * renaming a desktop or noting its version does not reconnect it. */
	const address = target ? `${target.id} ${target.origin} ${target.token}` : "";

	useEffect(() => {
		if (!instances.loaded) return;
		setSkew(null);
		if (!target) {
			setWired(null);
			void setWebTarget(null);
			return;
		}
		const id = target.id;
		setWired(id);
		void setWebTarget(
			{ origin: target.origin, token: target.token },
			{
				onStatus: setStatus,
				onRevoked: () => {
					// The desktop dropped this device. Nothing on this end can undo
					// that, so the row goes grey and the list comes back up.
					unlink(id);
					setStatus("idle");
					setSwitcher(true);
				},
			},
		);
	}, [instances.loaded, address, setStatus, unlink]);

	/* A version worth mentioning, once there is something to ask. Never a
	 * gate: an old desktop still answers most of this contract, and a phone
	 * that refuses to open is worse than one that reads a little wrong. */
	useEffect(() => {
		if (status !== "open" || !target) return;
		const id = target.id;
		let alive = true;
		void api.getAppInfo().then(
			(info) => {
				if (!alive) return;
				seen(id, info.version);
				if (info.version && info.version !== LOCAL_VERSION) setSkew(info.version);
			},
			// A desktop that cannot answer this has louder news than a version.
			() => {},
		);
		return () => {
			alive = false;
		};
	}, [status, address, seen]);

	/* Silence for a moment is a phone waking up; silence for four seconds is
	 * worth saying out loud, because the desktop may be off or moved and the
	 * only thing that helps is the list of the others. */
	const down = status === "connecting" || status === "reconnecting";
	useEffect(() => {
		if (!down) {
			setLost(false);
			return;
		}
		const timer = window.setTimeout(() => setLost(true), 4_000);
		return () => window.clearTimeout(timer);
	}, [down]);

	/* Forgetting is local; revoking is the desktop's own act. Both are tried,
	 * in that order, and an unreachable desktop still loses the row here. */
	const forget = async (instance: LinkedInstance): Promise<boolean> => {
		const revoked =
			instance.id === wired && instance.deviceId
				? await api.revokeWebDevice(instance.deviceId).then(
						({ revoked: done }) => done,
						() => false,
					)
				: false;
		instances.drop(instance.id);
		return revoked;
	};

	if (linking) {
		return (
			<LinkInstance
				relinking={linking.relinking}
				onCancel={() => setLinking(null)}
				onLinked={(paired) => {
					instances.link(paired);
					setLinking(null);
					setSwitcher(false);
				}}
			/>
		);
	}

	/* Nothing is drawn over a jar that has not been read yet: an empty list is
	 * a statement, and it would be the wrong one for a tick. */
	if (!instances.loaded) return <div className="h-full w-full bg-paper" />;

	if (!target || switcher) {
		return (
			<InstancesScreen
				instances={instances.instances}
				activeId={instances.jar.activeId}
				status={status}
				onPick={(id) => {
					instances.choose(id);
					setSwitcher(false);
				}}
				onLink={(instance) => setLinking({ relinking: instance })}
				onForget={forget}
				onClose={target ? () => setSwitcher(false) : undefined}
			/>
		);
	}

	// One tick, while the effect above points the wire at the row just chosen.
	if (wired !== target.id) return <div className="h-full w-full bg-paper" />;

	return (
		<Workspace
			/* Keyed per desktop: the roster, the transcripts and the selection all
			   belong to the machine they were read from, and none of it survives a
			   switch. */
			key={target.id}
			instanceChip={
				<InstanceChip instance={target} status={status} onClick={() => setSwitcher(true)} />
			}
			banner={
				lost ? (
					/* Above the panes, so this is what reaches the notch while it is
					   up and it owes that strip its own surface. */
					<aside className="note wire-note safe-head px-gutter pb-2xs">
						<span className="wire-pill">
							Looking for {target.name}…{" "}
							<button type="button" className="text-accent" onClick={() => setSwitcher(true)}>
								Instances
							</button>
						</span>
					</aside>
				) : skew ? (
					<aside className="note wire-note safe-head px-gutter pb-2xs" data-tone="quiet">
						<span className="wire-pill">
							This desktop runs Toad {skew} — the app was built from {LOCAL_VERSION}. Some things may not
							line up.
						</span>
					</aside>
				) : null
			}
		/>
	);
}

/**
 * The window itself: roster, conversation, and everything laid over them.
 *
 * `instanceChip` and `banner` are the phone's two additions — which desktop
 * this is, and anything the app has to say about the wire to it. On the
 * desktop both are absent and this is the whole app.
 */
function Workspace({ instanceChip, banner }: { instanceChip?: ReactNode; banner?: ReactNode }) {
	const toad = useToad();
	const peers = usePeerThreads(toad.selectedId, toad.ready);
	const schedules = useSchedules(toad.ready);
	const [settings, setSettings] = useState<SettingsRoute | null>(null);
	/* Where you were, per scope, so reopening returns you there rather than to
	 * the top of a list you have already read. Per window run only. */
	const lastSection = useRef<{
		teammate: TeammateSectionId;
		app: AppSectionId;
	}>({
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

	/* Web mode is the phone experience whatever the viewport says — a tablet
	 * in landscape still gets the mobile app, not a cramped desktop. */
	const narrow = useMedia(NARROW) || webClient();
	/* The phone is a navigation stack — roster underneath, conversation pushed
	 * over it — not a desktop window with a drawer. A *desktop* window squeezed
	 * narrow keeps the drawer: it has a pointer and no back gesture. */
	const stack = narrow && webClient();
	const [railOpen, setRailOpen] = useState(false);
	const showRail = stack || !narrow || railOpen;
	/* The pushed pane, for the platform's edge-swipe back. */
	const pushPane = useRef<HTMLElement>(null);
	const [threadsOpen, setThreadsOpen] = useState(false);
	const [computerOpen, setComputerOpen] = useState(false);
	const [searchOpen, setSearchOpen] = useState(false);
	/* The search hit the transcript should scroll to. Stamped so picking the
	 * same hit again still moves. */
	const [focus, setFocus] = useState<{ eventId: string; at: number } | null>(null);
	/* A hand-to-human card opens the drawer straight onto the screen — the
	 * card promised "open the computer", not "open a panel about it". */
	const [computerScreenFirst, setComputerScreenFirst] = useState(false);

	// Both toolbar segments share one hairline, so it lights across the whole
	// window rather than under whichever pane happens to have scrolled.
	const [railScrolled, setRailScrolled] = useState(false);
	const [paneScrolled, setPaneScrolled] = useState(false);
	const scrolled = railScrolled || paneScrolled;

	const { selected, sessionInfo } = toad;

	const openSettings = (scope: "teammate" | "app", section?: string) => {
		if (scope === "teammate" && selected === null) return;
		/* On the stack, settings are a cover over wherever you are, and closing
		 * them puts you back there — so the roster stays the screen underneath
		 * when that is where you opened them from. The drawer model instead
		 * folds the rail away, because there the two would fight. */
		if (!stack) setRailOpen(false);
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

	/* Deleting from a menu and deleting from the inspector are the same act: the
	 * teammate goes, the identity edits nobody saved go with it, and the pane it
	 * was being edited in has nothing left to show. */
	const deleteTeammate = (id: string) => {
		void toad.removePersona(id).then((deleted) => {
			if (!deleted) return;
			setIdentityDrafts((current) => {
				const { [id]: _gone, ...rest } = current;
				return rest;
			});
			closeSettings();
		});
	};

	useEdgeSwipe(pushPane, stack && !railOpen && selected !== null, () => setRailOpen(true));

	/* The turn ending is the moment the phone was waiting for — say so in the
	 * hand, once, and only for the conversation on screen. */
	const wasWorking = useRef(false);
	useEffect(() => {
		const working = sessionInfo ? isWorking(sessionInfo.state) : false;
		if (stack && wasWorking.current && !working) hapticDone();
		wasWorking.current = working;
	}, [stack, sessionInfo]);

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
	 * outright rather than sitting beside it. On the stack nothing overlays:
	 * the roster is the screen underneath. */
	const overlaid = narrow && railOpen && !stack;
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

	/* Threads belong to the teammate they were opened from, so moving to another
	 * one closes the list rather than swapping its contents underneath you.
	 * The computer drawer is the same shape of thing. */
	useEffect(() => {
		setThreadsOpen(false);
		setComputerOpen(false);
		setSearchOpen(false);
		setFocus(null);
	}, [toad.selectedId]);

	/* Popping to the roster closes whatever was over the conversation: the
	 * stack keeps the pane mounted, so leaving it must do what unmounting
	 * used to. */
	useEffect(() => {
		if (!stack || !railOpen) return;
		setThreadsOpen(false);
		setComputerOpen(false);
		setSearchOpen(false);
	}, [stack, railOpen]);

	/* ⌘F / Ctrl+F opens search on the conversation in focus, the way it does
	 * in a messages app. Not while settings are up: there is no transcript to
	 * search behind them. */
	useEffect(() => {
		if (!selected || settings !== null) return;
		const onKey = (event: KeyboardEvent) => {
			if (event.key !== "f" || !(event.metaKey || event.ctrlKey) || event.shiftKey || event.altKey) return;
			event.preventDefault();
			setSearchOpen(true);
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [selected, settings]);

	/* Settings sections are peers, not a stack: Escape leaves settings outright.
	 * Without settings, it still dismisses a roster laid over a conversation.
	 *
	 * The threads pair is the one real stack in the window — a thread is opened
	 * from the list and closing it should land you back on the list — so Escape
	 * unwinds those two in order before it considers anything else. */
	useEffect(() => {
		const covered =
			peers.openKey !== null ||
			threadsOpen ||
			computerOpen ||
			searchOpen ||
			settings !== null ||
			(overlaid && selected !== null);
		if (!covered) return;
		const close = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return;
			if (peers.openKey) peers.close();
			else if (threadsOpen) setThreadsOpen(false);
			else if (computerOpen) setComputerOpen(false);
			else if (searchOpen) setSearchOpen(false);
			else if (settings) closeSettings();
			else dismiss();
		};
		window.addEventListener("keydown", close);
		return () => window.removeEventListener("keydown", close);
	}, [peers.openKey, peers.close, threadsOpen, computerOpen, searchOpen, settings, overlaid, selected]);

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

	/* The native menu bar and the right-click menus name an intent and stop
	 * there. Every one of them lands here, on the same paths the buttons use.
	 *
	 * The handler reads state that changes constantly — the transcript grows
	 * with every token of a reply — so it is kept in a ref that each render
	 * refreshes and subscribed to once. Naming those values as dependencies
	 * would tear the menu's listener down and rebuild it on every paint. */
	const onMenuAction = useRef<(payload: MenuAction) => void>(() => {});
	onMenuAction.current = ({ action, personaId }) => {
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
				if (id) deleteTeammate(id);
				return;
			case "about":
				openSettings("app", "about");
				return;
			case "quit":
				void api.appQuit();
				return;
			case "minimize":
				void api.windowMinimize().then(setWin);
				return;
			case "maximize":
				void api.windowMaximizeToggle().then(setWin);
				return;
			case "toggleFullScreen":
				void api.windowSetFullScreen(!win.fullScreen).then(setWin);
				return;
			case "closeWindow":
				void api.windowClose();
				return;
		}
	};

	useEffect(() => on("menuAction", (payload) => onMenuAction.current(payload)), []);

	/* Electrobun's native menu bar is what binds ⌘N / ⌘, / ⌘1–⌘9. On Linux
	 * that bar does not exist, so the same accelerators are listened for here
	 * and run through the same handler the menu items would have used. */
	const personasRef = useRef(toad.personas);
	personasRef.current = toad.personas;
	useEffect(() => {
		if (nativeMenus()) return;
		const onKey = (event: KeyboardEvent) => {
			if (event.isComposing || event.repeat) return;
			if (!event.ctrlKey || event.altKey || event.metaKey) return;
			const digit = event.shiftKey ? "" : event.key;
			if (digit >= "1" && digit <= "9") {
				const persona = personasRef.current[Number(digit) - 1];
				if (!persona) return;
				event.preventDefault();
				onMenuAction.current({
					action: "selectTeammate",
					personaId: persona.id,
				});
				return;
			}
			const key = event.key.toLowerCase();
			if (event.shiftKey && key === "o") {
				event.preventDefault();
				onMenuAction.current({ action: "revealWorkspace" });
				return;
			}
			if (event.shiftKey && key === "r") {
				event.preventDefault();
				onMenuAction.current({ action: "stopSession" });
				return;
			}
			if (event.shiftKey) return;
			const action =
				key === "n"
					? "newTeammate"
					: key === ","
						? "appSettings"
						: key === "i"
							? "settings"
							: key === "r"
								? "startSession"
								: key === "."
									? "cancelTurn"
									: null;
			if (!action) return;
			event.preventDefault();
			onMenuAction.current({ action });
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, []);

	const [popup, setPopup] = useState<{
		x: number;
		y: number;
		items: PopupItem[];
	} | null>(null);
	const closePopup = () => setPopup(null);
	const [win, setWin] = useState<WindowState>({
		maximized: false,
		fullScreen: false,
	});

	useEffect(() => {
		if (!linuxChrome()) return;
		void api.windowState().then(setWin);
		return on("windowStateChanged", setWin);
	}, []);

	const onPersonaMenu = (personaId: string, event: ReactMouseEvent) => {
		if (nativeMenus()) {
			void api.showPersonaMenu(personaId);
			return;
		}
		const state = toad.sessions[personaId]?.state ?? "idle";
		const running = isUp(state);
		setPopup({
			x: event.clientX,
			y: event.clientY,
			items: [
				{
					label: running ? "Stop Session" : "Start Session",
					onClick: () =>
						onMenuAction.current({
							action: running ? "stopSession" : "startSession",
							personaId,
						}),
				},
				{ type: "divider" },
				/* Finder is on the desk; the phone's menu does not offer it. */
				...(webClient()
					? []
					: [
							{
								label: "Reveal Workspace",
								onClick: () => onMenuAction.current({ action: "revealWorkspace", personaId }),
							},
						]),
				{
					label: "Rename…",
					onClick: () => onMenuAction.current({ action: "renameTeammate", personaId }),
				},
				{ type: "divider" },
				{
					label: "Delete Teammate",
					danger: true,
					onClick: () => onMenuAction.current({ action: "deleteTeammate", personaId }),
				},
			],
		});
	};

	const onMessageMenu = (text: string, event: ReactMouseEvent) => {
		if (nativeMenus()) {
			void api.showMessageMenu(text);
			return;
		}
		setPopup({
			x: event.clientX,
			y: event.clientY,
			items: [{ label: "Copy Message", onClick: () => void api.writeClipboard(text) }],
		});
	};

	return (
		<div className="flex h-full w-full flex-col overflow-hidden bg-paper-2">
			{linuxChrome() && !win.maximized && !win.fullScreen && (
				<div className="window-edge" aria-hidden="true" />
			)}
			{linuxChrome() && (
				<ChromeStrip
					title={windowTitle(selected?.name)}
					maximized={win.maximized}
					items={htmlMenuItems(
						{
							personas: toad.personas,
							activeId: toad.selectedId,
							activeState: sessionInfo?.state ?? "idle",
						},
						(action) => onMenuAction.current(action),
					)}
					onMinimize={() => void api.windowMinimize().then(setWin)}
					onMaximizeToggle={() => void api.windowMaximizeToggle().then(setWin)}
					onClose={() => void api.windowClose()}
				/>
			)}
			{linuxChrome() && !win.maximized && !win.fullScreen && <ResizeHandles />}
			{banner}
			{/* A banner is what reaches the notch while it is up, so the chrome
			    below it has no inset left to take. */}
			<div
				className={`relative flex min-h-0 flex-1 overflow-hidden ${stack ? "stack" : ""} ${banner ? "inset-spent" : ""}`}
				data-pushed={stack && !railOpen && selected !== null ? "true" : undefined}
			>
				{showRail && (
					<Sidebar
						stackBase={stack}
						stackCovered={stack && !railOpen && selected !== null}
						personas={toad.personas}
						sessions={toad.sessions}
						previews={toad.previews}
						peerActivity={peers.activity}
						schedules={schedules.byPersona}
						selectedId={toad.selectedId}
						adding={adding}
						scrolled={scrolled}
						drawer={narrow}
						beforeFooter={instanceChip}
						onAddingChange={setAdding}
						onScrollEdge={setRailScrolled}
						onSelect={(id) => {
							toad.setSelectedId(id);
							// Picking someone is the reason the drawer was opened.
							setRailOpen(false);
							closeSettings();
						}}
						onOpenAppSettings={() => openSettings("app")}
						onPersonaMenu={onPersonaMenu}
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
						ref={pushPane}
						className={`relative flex min-w-0 flex-1 flex-col bg-paper ${curveOf(narrow)} ${stack ? "stack-push" : ""}`}
						data-open={stack ? !railOpen : undefined}
						onTouchStartCapture={(event) => {
							/* Touching the conversation puts the keyboard away, the way a
							 * messages app does. Touches on the composer itself are its
							 * own business. */
							if (!stack) return;
							const active = document.activeElement;
							if (!(active instanceof HTMLTextAreaElement)) return;
							if ((event.target as HTMLElement).closest(".composer-scrim")) return;
							active.blur();
						}}
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
							searchOpen={searchOpen}
							covered={stack ? railOpen : undefined}
							onOpenSearch={() => setSearchOpen((open) => !open)}
							threads={peers.threads}
							threadsSeenAt={peers.seenAt}
							threadsOpen={threadsOpen}
							onOpenThreads={() => {
								/* Closing from the header closes the pair. Leaving a thread up
								   with the list gone puts you in the middle of a stack whose
								   way back has been taken away. */
								if (threadsOpen) {
									peers.close();
									setThreadsOpen(false);
									return;
								}
								peers.markSeen();
								setThreadsOpen(true);
							}}
							jobs={schedules.byPersona[selected.id] ?? []}
							onCancelSchedule={schedules.cancel}
							computerOpen={computerOpen}
							onOpenComputer={() => setComputerOpen((open) => !open)}
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
							onStop={() => void toad.stopSession(selected.id)}
							onSetModel={(modelId) => void toad.setModel(selected.id, modelId)}
							onSetMode={(modeId) => void toad.setMode(selected.id, modeId)}
							onSetConfig={(configId, value) => void toad.setConfig(selected.id, configId, value)}
							onToggleSettings={() => openSettings("teammate")}
						/>

						{/* Keyed per teammate so switching resets scroll pinning and so a
						    replayed transcript is treated as history, not as new arrivals. */}
						<Transcript
							key={selected.id}
							events={toad.transcript}
							working={isWorking(sessionInfo.state)}
							onScrollEdge={setPaneScrolled}
							onPacing={setPacing}
							onOpenPeerThread={peers.open}
							onMessageMenu={onMessageMenu}
							focus={focus}
							onAnswerPermission={(requestId, optionId) =>
								void toad.answerPermission(selected.id, requestId, optionId)
							}
							onAnswerHumanAction={(actionId, status) => void api.answerHumanAction(actionId, status)}
							onOpenComputer={
								selected.computer?.enabled
									? () => {
											setComputerScreenFirst(true);
											setComputerOpen(true);
										}
									: undefined
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
							onSteer={(text, attachments) => void toad.steer(selected.id, text, attachments)}
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
					onSwitchBackend={(backendId) =>
						selected ? toad.switchBackend(selected.id, backendId) : Promise.resolve()
					}
					onDeletePersona={() => {
						if (selected) deleteTeammate(selected.id);
					}}
					onPickWorkspace={() => toad.pickWorkspace(selected?.cwd)}
					onRevealWorkspace={() => {
						if (selected) void toad.revealWorkspace(selected.id);
					}}
					onRefreshBackends={toad.refreshBackends}
				/>
			)}

			{/* Creating a teammate covers the window, like settings do: it is a
			    screen, not a form in the rail's footer. */}
			{adding && (
				<NewTeammate
					backends={toad.backends}
					onCreate={(draft) => toad.createPersona(draft)}
					onFaceChosen={(persona) => toad.absorbPersona(persona)}
					onClose={() => setAdding(false)}
					onChat={(personaId) => {
						setAdding(false);
						toad.setSelectedId(personaId);
						setRailOpen(false);
					}}
				/>
			)}

			{/* The list, then the thread over it: closing a thread lands back on the
			    list rather than on the conversation you opened it from. */}
			{threadsOpen && selected && (
				<ThreadsDrawer
					threads={peers.threads}
					openKey={peers.openKey}
					covered={peers.openKey !== null}
					seenAt={peers.seenAt}
					onSelect={peers.open}
					onClose={() => {
						peers.close();
						setThreadsOpen(false);
					}}
				/>
			)}

			{searchOpen && selected && (
				<SearchDrawer
					personaId={selected.id}
					onJump={(eventId) => setFocus({ eventId, at: Date.now() })}
					onClose={() => setSearchOpen(false)}
				/>
			)}

			{computerOpen && selected && (
				<ComputerDrawer
					persona={selected}
					initialScreen={computerScreenFirst}
					onClose={() => {
						setComputerOpen(false);
						setComputerScreenFirst(false);
					}}
				/>
			)}

			{peers.openKey && (
				<PeerThreadViewer
					thread={peers.thread}
					onAnswerPermission={(requestId, optionId) =>
						void peers.answerPermission(requestId, optionId)
					}
					onClose={peers.close}
					onMessageMenu={onMessageMenu}
				/>
			)}

			{popup && <PopupMenu x={popup.x} y={popup.y} items={popup.items} onClose={closePopup} />}
			</div>
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
			<Toolbar className={lights && insetLights() ? "pl-lights" : ""} />
			<div className="flex flex-1 items-center justify-center px-gutter pb-2xl">
				<div className="max-w-[26rem]">
					<h2 className="text-xl text-ink">{ready ? "No teammate selected" : "Loading…"}</h2>
					{ready && (
						<p className="mt-xs text-sm leading-relaxed text-ink-3">
							Add a teammate with the + button
							{shortcutLabel("N") ? `, or press ${shortcutLabel("N")}` : ""}. Each one is a persistent agent
							with its own identity, its own working directory, and its own conversation — and you talk to it
							the way you would talk to anyone else.
						</p>
					)}
				</div>
			</div>
		</main>
	);
}
