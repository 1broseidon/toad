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
import { flattenTeamRoster } from "../shared/roster";
import { isUp, isWorking } from "../shared/session";
import { htmlMenuItems } from "./app-menu";
import { ChatHeader } from "./components/ChatHeader";
import { ConfirmSheet } from "./components/ConfirmSheet";
import { chromeAvailable, onChromeAction, setChrome } from "./chrome";
import { dropCache } from "./cache";
import { oneShotRpc } from "./instances/oneShot";
import { probeDesk } from "./node-join";
import type { FleetNodeRoster } from "../shared/types";
import { PhoneSettings } from "./components/settings/PhoneSettings";
import { ChromeStrip } from "./components/ChromeStrip";
import { ResizeHandles } from "./components/ResizeHandles";
import { Composer } from "./components/Composer";
import { ComputerDrawer } from "./components/ComputerDrawer";
import { PeerThreadViewer } from "./components/PeerThreadViewer";
import { ThreadsDrawer } from "./components/ThreadsDrawer";
import { GlobalSearch } from "./components/GlobalSearch";
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
import { activeRoomOf, bestDeskOf, type LinkedInstance, type RoomEntry, roomsOf } from "./instances/store";
import { useInstances } from "./instances/useInstances";
import { insetLights, linuxChrome, nativeMenus, nativeShell, shortcutLabel, webClient } from "./platform";
import { api, on, onWireRestored, setWebTarget } from "./rpc";
import { useActivity } from "./useActivity";
import { useMedia } from "./useMedia";
import { useEdgeSwipe } from "./useEdgeSwipe";
import { hapticDone, hapticTap } from "./haptics";
import { drainShareInbox, type SharedItems } from "./shareInbox";
import { onPushOpened, registerForPush } from "./push";
import { BubbleSheet } from "./components/BubbleSheet";
import { usePeerThreads } from "./usePeerThreads";
import { useConnectionPin } from "./prefs";
import { takeFleetSeed } from "./instances/seed";
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
	/* A remote teammate was tapped: switch worlds, then open them. */
	const [pendingSelect, setPendingSelect] = useState<{
		instanceId: string;
		personaId: string;
	} | null>(() => {
		/* A fleet-opened window names the teammate that was clicked. */
		const seed = takeFleetSeed();
		return seed?.select ? { instanceId: seed.id, personaId: seed.select } : null;
	});
	const [linking, setLinking] = useState<{ relinking?: LinkedInstance } | null>(null);
	/* Auto unless pinned: the phone rides its current hub while healthy and
	 * walks to another linked desk when it is not. One room from any seat. */
	const pin = useConnectionPin();
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

	/* Phase 1 of the routing spec: automatic gateway failover. When Auto and
	 * the active wire has been down for a beat, probe the other linked desks
	 * with a short fuse and walk to the quickest one that answers. Affinity
	 * holds — nothing moves while the current hub is healthy — and a pin
	 * turns this off entirely. */
	const failTarget = target?.id ?? null;
	useEffect(() => {
		if (pin || !failTarget || status === "open" || status === "idle") return;
		/* A walk stays inside the room: another room is another context, and
		 * a legacy direct link has nowhere to walk at all. */
		const failRoom = target?.auth === "node" ? (target.roomId ?? null) : null;
		const others = instances.instances.filter(
			(row) =>
				row.id !== failTarget &&
				row.state === "linked" &&
				failRoom !== null &&
				row.auth === "node" &&
				row.roomId === failRoom,
		);
		if (others.length === 0) return;
		let cancelled = false;
		const timer = window.setTimeout(async () => {
			const probes = await Promise.all(
				others.map(async (row) => {
					const started = Date.now();
					try {
						/* A member row proves a desk is up by asking for a challenge —
						 * no signature spent on a desk that may not answer. */
						if (row.auth === "node") {
							const alive = await probeDesk(row.origin, 4_000);
							if (!alive) return null;
						} else {
							await oneShotRpc(row.origin, row.token, "ping", {}, 4_000);
						}
						return { row, rtt: Date.now() - started };
					} catch {
						return null;
					}
				}),
			);
			if (cancelled) return;
			const best = probes
				.filter((probe): probe is { row: LinkedInstance; rtt: number } => probe !== null)
				.sort((a, b) => a.rtt - b.rtt)[0];
			if (best) instances.choose(best.row.id);
		}, 12_000);
		return () => {
			cancelled = true;
			window.clearTimeout(timer);
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [pin, failTarget, status]);

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
			{ origin: target.origin, token: target.token, node: target.auth === "node" },
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

	/* A member wire opening is the moment to re-read the grant: a desk added
	 * on any desktop appears in this list without another scan, and one
	 * removed goes grey the same way. The active row never moves — this is
	 * bookkeeping, not navigation. */
	useEffect(() => {
		if (status !== "open" || target?.auth !== "node") return;
		let alive = true;
		void api.myDesktops().then(
			({ room, desktops }) => {
				if (alive) instances.joinRoom(desktops, undefined, room);
			},
			// A desk that cannot answer this still answers the room; nothing to do.
			() => {},
		);
		return () => {
			alive = false;
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [status, address]);

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
		dropCache(instance.id);
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
				onJoined={(room) => {
					/* One membership, whole room: every granted desk lands as a
					 * row, and the desk whose QR was scanned is the one opened. */
					instances.joinRoom(room.desktops, room.desk.nodeId, room.room);
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
				onLeaveRoom={() => {
					for (const id of instances.leave()) dropCache(id);
				}}
				onClose={target ? () => setSwitcher(false) : undefined}
			/>
		);
	}

	// One tick, while the effect above points the wire at the row just chosen.
	if (wired !== target.id) return <div className="h-full w-full bg-paper" />;


	return (
		<>
		<Workspace
			/* Keyed per desktop: the roster, the transcripts and the selection all
			   belong to the machine they were read from, and none of it survives a
			   switch. */
			key={target.id}
			instanceChip={
				<InstanceChip instance={target} status={status} onClick={() => setSwitcher(true)} />
			}
			desktopName={target.name}
			desktopId={target.id}
			wired={status === "open"}
			rooms={roomsOf(instances.jar)}
			activeRoomKey={activeRoomOf(instances.jar)?.key ?? null}
			onSwitchRoom={(key) => {
				/* Switching rooms is switching contexts: land on the room's best
				 * desk and let the wire follow. */
				const room = roomsOf(instances.jar).find((entry) => entry.key === key);
				const desk = room ? bestDeskOf(room) : null;
				if (desk) instances.choose(desk.id);
			}}
			onJoinRoom={() => setLinking({})}
			onManageDesktops={() => setSwitcher(true)}
			overlayUp={false}
			initialPersonaId={
				pendingSelect?.instanceId === target.id ? pendingSelect.personaId : undefined
			}
			onConsumedSelect={() => setPendingSelect(null)}
			onPushToken={(token, environment) => {
				/* Every linked desk learns this phone's APNs token, not just the
				 * hub — any desk holding a push key can then buzz this pocket.
				 * Best effort; the next launch re-offers to whoever missed.
				 * Member rows are skipped: a one-shot has no bearer to present,
				 * so each desk learns the token over its own wire when the phone
				 * next opens it. */
				for (const row of instances.instances) {
					if (row.id === target.id || row.state !== "linked" || row.auth === "node") continue;
					void oneShotRpc(row.origin, row.token, "registerPushDevice", {
						token,
						environment,
					}, 8_000).catch(() => {});
				}
			}}
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
		</>
	);
}

/**
 * The window itself: roster, conversation, and everything laid over them.
 *
 * `instanceChip` and `banner` are the phone's two additions — which desktop
 * this is, and anything the app has to say about the wire to it. On the
 * desktop both are absent and this is the whole app.
 */
function Workspace({
	instanceChip,
	banner,
	desktopName,
	desktopId,
	wired,
	rooms,
	activeRoomKey,
	onSwitchRoom,
	onJoinRoom,
	onManageDesktops,
	overlayUp,
	initialPersonaId,
	onConsumedSelect,
	onPushToken,
}: {
	instanceChip?: ReactNode;
	banner?: ReactNode;
	/** The linked desktop's name and the way to its switcher, for settings. */
	desktopName?: string;
	/** Its stable id — the key the cold-open cache files this world under. */
	desktopId?: string;
	/** Whether the wire is open right now — the chrome's status dot. */
	wired?: boolean;
	/** The rooms this phone is joined to, for the settings sheet. */
	rooms?: RoomEntry[];
	activeRoomKey?: string | null;
	onSwitchRoom?: (key: string) => void;
	onJoinRoom?: () => void;
	onManageDesktops?: () => void;
	/** An overlay above this whole tree (the computers sheet) — the native
	 * chrome must duck under it just like under anything of our own. */
	overlayUp?: boolean;
	/** A conversation to land in, carried across an instance switch. */
	initialPersonaId?: string;
	onConsumedSelect?: () => void;
	/** A fresh APNs token, for the shell to offer to the other linked desks. */
	onPushToken?: (token: string, environment: "sandbox" | "production") => void;
}) {
	const toad = useToad(desktopId);
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
	const [addingTeam, setAddingTeam] = useState<string | undefined>();
	// Bumped when a menu asks to rename, so the settings panel takes the caret.
	const [renameNonce, setRenameNonce] = useState(0);

	/* Web mode is the phone experience whatever the viewport says — a tablet
	 * in landscape still gets the mobile app, not a cramped desktop. */
	const narrow = useMedia(NARROW) || webClient();
	/* The phone is a navigation stack — roster underneath, conversation pushed
	 * over it — not a desktop window with a drawer. A *desktop* window squeezed
	 * narrow keeps the drawer: it has a pointer and no back gesture. */
	const stack = narrow && webClient();
	/* Whether linked desktops' teammates fold into this rail — the "one
	 * room" preference, shared by phone and desktop settings. */
	const [railOpen, setRailOpen] = useState(false);

	/* The native glass chrome (iOS) replaces the roster's footer: bar and
	 * pill show with the Team screen and step aside for anything pushed or
	 * laid over it. The plugin itself yields to the keyboard. */
	const chromeOn = chromeAvailable() && stack;
	const showRail = stack || !narrow || railOpen;
	/* The pushed pane, for the platform's edge-swipe back. */
	const pushPane = useRef<HTMLElement>(null);
	const [threadsOpen, setThreadsOpen] = useState(false);
	const [computerOpen, setComputerOpen] = useState(false);
	const [searchOpen, setSearchOpen] = useState(false);
	/* The search hit the transcript should scroll to. Stamped so picking the
	 * same hit again still moves. */
	const [focus, setFocus] = useState<{ eventId: string; at: number } | null>(null);
	/* A long-pressed bubble's sheet, and the message a reply is quoting. */
	const [bubbleSheet, setBubbleSheet] = useState<{
		eventId: string;
		text: string;
		from: "me" | "them";
	} | null>(null);
	const [replyTo, setReplyTo] = useState<{ eventId: string; from: "me" | "them"; text: string } | null>(
		null,
	);
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
	 * was being edited in has nothing left to show.
	 *
	 * Who asks "are you sure" depends on where the thumb is. The desktop asks
	 * through the system's message box (bun side). A web client asks with its
	 * own sheet and sends `confirmed` — the desktop modal would freeze every
	 * wire while the question waited at a desk nobody is sitting at. */
	const [confirmDelete, setConfirmDelete] = useState<{ id: string; name: string } | null>(null);
	const destroyTeammate = (id: string, confirmed: boolean) => {
		void toad.removePersona(id, confirmed).then((deleted) => {
			if (!deleted) return;
			setIdentityDrafts((current) => {
				const { [id]: _gone, ...rest } = current;
				return rest;
			});
			closeSettings();
		});
	};
	const deleteTeammate = (id: string) => {
		if (webClient()) {
			const persona = toad.personas.find((p) => p.id === id);
			if (persona) setConfirmDelete({ id, name: persona.name });
			return;
		}
		destroyTeammate(id, false);
	};

	/* Declared here rather than with the menus below: the chrome's visibility
	 * reads it, and a const cannot be read before its line. */
	const [popup, setPopup] = useState<{
		x: number;
		y: number;
		items: PopupItem[];
	} | null>(null);
	const closePopup = () => setPopup(null);

	const chromeShowing =
		chromeOn &&
		(railOpen || selected === null) &&
		!settings &&
		!adding &&
		!confirmDelete &&
		!popup &&
		!searchOpen &&
		!overlayUp;
	const manageDesktops = useRef(onManageDesktops);
	manageDesktops.current = onManageDesktops;
	useEffect(() => {
		if (!chromeOn) return;
		setChrome({ linked: wired ?? false, bar: chromeShowing });
	}, [chromeOn, chromeShowing, wired]);

	/* The rest of the fleet, through this desktop's eyes. Presence only, a
	 * beat behind — enough for the merged room; conversations still travel
	 * point-to-point when a row is tapped. */
	const fleetCacheKey = `toad.fleet.${desktopId ?? "local"}`;
	/* Bumped to re-poll at once — e.g. a teammate was just minted elsewhere. */
	const [fleetNonce, setFleetNonce] = useState(0);
	const [fleet, setFleet] = useState<FleetNodeRoster[]>(() => {
		/* Last known rosters for THIS desktop, so walking back from another
		 * desktop shows the whole room at once instead of a local-only list
		 * that fills in when the next poll lands. Presence may be a beat
		 * stale; the poll below corrects it. */
		try {
			return JSON.parse(localStorage.getItem(fleetCacheKey) ?? "[]") as FleetNodeRoster[];
		} catch {
			return [];
		}
	});
	useEffect(() => {
		let cancelled = false;
		const poll = () => {
			void api.fleetRoster().then(
				({ rosters }) => {
					if (cancelled) return;
					setFleet(rosters);
					try {
						localStorage.setItem(fleetCacheKey, JSON.stringify(rosters));
					} catch {
						/* Cache only; the live poll still carries the room. */
					}
				},
				() => {},
			);
		};
		poll();
		const timer = window.setInterval(poll, 20_000);
		const offRestore = onWireRestored(poll);
		return () => {
			cancelled = true;
			window.clearInterval(timer);
			offRestore();
		};
	}, [fleetCacheKey, fleetNonce]);

	/* Landing after a walk across desktops: the tapped teammate opens. */
	useEffect(() => {
		if (!initialPersonaId || !toad.ready) return;
		toad.setSelectedId(initialPersonaId);
		setRailOpen(false);
		onConsumedSelect?.();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [initialPersonaId, toad.ready]);

	useEffect(() => {
		if (!chromeOn) return;
		const off = onChromeAction((id) => {
			if (id === "add") onMenuAction.current({ action: "newTeammate" });
			else if (id === "settings") onMenuAction.current({ action: "appSettings" });
		});
		return () => {
			setChrome({ bar: false });
			off();
		};
	}, [chromeOn]);

	useEdgeSwipe(pushPane, stack && !railOpen && selected !== null, () => setRailOpen(true));

	/* Registering this phone for push, once — and again on every resume,
	 * since Apple can rotate the token whenever it feels like it. Permission
	 * is asked here rather than at launch, so the first thing a fresh install
	 * sees is not a system dialog: by the time this runs a desktop is
	 * already linked, which is the moment "notify me" starts meaning
	 * something. */
	/* The token Apple handed us, until the desktop has acknowledged it.
	 *
	 * Held rather than sent-and-forgotten because the two are not in step:
	 * Apple answers `register()` from a cache within milliseconds, while the
	 * wire is still opening — this pane mounts as soon as a desktop is
	 * *chosen*, not once it is reachable. A token dropped into a socket that
	 * is not up yet is gone for good, because `registration` fires once per
	 * launch. So it waits here and is re-offered until something says yes. */
	const pendingToken = useRef<{ token: string; environment: "sandbox" | "production" } | null>(null);
	const [tokenNonce, setTokenNonce] = useState(0);

	useEffect(() => {
		if (!stack) return;
		let alive = true;
		const attempt = () =>
			void registerForPush(
				(token, environment) => {
					if (!alive) return;
					pendingToken.current = { token, environment };
					setTokenNonce((n) => n + 1);
					onPushToken?.(token, environment);
				},
				(reason) => {
					if (alive) void api.reportPushProblem(reason).catch(() => {});
				},
			).catch((error) => {
				if (alive) void api.reportPushProblem(String(error)).catch(() => {});
			});
		attempt();
		let handle: { remove(): Promise<void> } | undefined;
		void import("@capacitor/app").then(async ({ App }) => {
			handle = await App.addListener("resume", attempt);
		});
		return () => {
			alive = false;
			void handle?.remove().catch(() => {});
		};
	}, [stack]);

	/* Handing the token over, and keeping at it until it lands. Retried on a
	 * timer and again whenever the wire comes back, because the failure this
	 * guards against is precisely a wire that was not ready yet. */
	useEffect(() => {
		const pending = pendingToken.current;
		if (!stack || !pending) return;
		let alive = true;
		let timer: number | undefined;
		const offer = () => {
			void api.registerPushDevice(pending.token, pending.environment).then(
				(result) => {
					if (!alive) return;
					if (result?.registered) pendingToken.current = null;
					else timer = window.setTimeout(offer, 5_000);
				},
				() => {
					if (alive) timer = window.setTimeout(offer, 5_000);
				},
			);
		};
		offer();
		const off = onWireRestored(offer);
		return () => {
			alive = false;
			window.clearTimeout(timer);
			off();
		};
	}, [stack, tokenNonce]);

	/* A tapped notification opens straight into that teammate's conversation
	 * — the same path the menu bar's own "select this teammate" takes. */
	useEffect(() => {
		if (!stack) return;
		let handle: (() => void) | undefined;
		void onPushOpened((personaId, node) => {
			const resolved = node && desktopId && node !== desktopId ? `${node}/${personaId}` : personaId;
			onMenuAction.current({ action: "selectTeammate", personaId: resolved });
		}).then((off) => {
			handle = off;
		});
		return () => handle?.();
	}, [stack, desktopId]);

	/* What the share sheet delivered, waiting for a conversation to land in.
	 * Drained on launch and on every resume; applied the moment a teammate is
	 * selected — which is usually already true, and the handoff is invisible. */
	const shared = useRef<SharedItems | null>(null);
	const [sharedNonce, setSharedNonce] = useState(0);
	useEffect(() => {
		if (!stack) return;
		let alive = true;
		const check = () =>
			void drainShareInbox().then((items) => {
				if (!alive || (items.files.length === 0 && items.texts.length === 0)) return;
				const held = shared.current;
				shared.current = held
					? { files: [...held.files, ...items.files], texts: [...held.texts, ...items.texts] }
					: items;
				setSharedNonce((n) => n + 1);
			});
		check();
		let handle: { remove(): Promise<void> } | undefined;
		void import("@capacitor/app").then(async ({ App }) => {
			handle = await App.addListener("resume", check);
		});
		return () => {
			alive = false;
			void handle?.remove().catch(() => {});
		};
	}, [stack]);

	const draftRef = useRef(toad.draft);
	draftRef.current = toad.draft;
	useEffect(() => {
		const items = shared.current;
		const id = toad.selectedId;
		if (!items || !id) return;
		shared.current = null;
		void (async () => {
			if (items.files.length > 0) {
				const saved = await Promise.all(
					items.files.map((file) => api.saveAttachment(id, file.name, file.mimeType, file.data)),
				);
				toad.addAttachments(id, saved);
			}
			if (items.texts.length > 0) {
				const draft = draftRef.current;
				toad.setDraft(id, {
					...draft,
					text: [draft.text, ...items.texts].filter(Boolean).join("\n"),
				});
			}
			hapticTap();
		})();
	}, [sharedNonce, toad.selectedId]);

	/* The turn ending is the moment the phone was waiting for — say so in the
	 * hand, once, and only for the conversation on screen. Backgrounding
	 * drops the claim: a turn that finishes in the pocket is APNs's news,
	 * and a second buzz on reopening would announce it twice. */
	const wasWorking = useRef(false);
	useEffect(() => {
		const drop = () => {
			if (document.visibilityState !== "visible") wasWorking.current = false;
		};
		document.addEventListener("visibilitychange", drop);
		return () => document.removeEventListener("visibilitychange", drop);
	}, []);
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
		setBubbleSheet(null);
		setReplyTo(null);
	}, [toad.selectedId]);

	/* Popping to the roster closes whatever was over the conversation: the
	 * stack keeps the pane mounted, so leaving it must do what unmounting
	 * used to. */
	useEffect(() => {
		if (!stack || !railOpen) return;
		setThreadsOpen(false);
		setComputerOpen(false);
		setSearchOpen(false);
		setBubbleSheet(null);
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
				setAddingTeam(undefined);
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
	const shortcutPersonasRef = useRef(flattenTeamRoster(toad.personas));
	shortcutPersonasRef.current = flattenTeamRoster(toad.personas);
	useEffect(() => {
		if (nativeMenus()) return;
		const onKey = (event: KeyboardEvent) => {
			if (event.isComposing || event.repeat) return;
			if (!event.ctrlKey || event.altKey || event.metaKey) return;
			const digit = event.shiftKey ? "" : event.key;
			if (digit >= "1" && digit <= "9") {
				const persona = shortcutPersonasRef.current[Number(digit) - 1];
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
				/* The phone's way into a teammate's settings: the roster is the
				   contact list, so its long-press carries the contact card. */
				...(webClient()
					? [
							{
								label: "Settings",
								onClick: () => {
									onMenuAction.current({ action: "selectTeammate", personaId });
									onMenuAction.current({ action: "settings", personaId });
								},
							},
						]
					: []),
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

	/* A bubble's menu is the same everywhere a pointer exists: the quick
	 * marks, then reply and copy. In the page rather than native on purpose —
	 * an NSMenu cannot hold a row of reactions, and six vertical emoji menu
	 * items would be the wrong kind of memorable. */
	const onMessageMenu = (
		info: { eventId: string; text: string; from: "me" | "them" },
		event: ReactMouseEvent,
	) => {
		const personaId = toad.selectedId;
		if (!personaId) return;
		setPopup({
			x: event.clientX,
			y: event.clientY,
			items: [
				{
					type: "reactions",
					marks: ["👍", "❤️", "😂", "🎉", "👀", "🙏"],
					onPick: (mark) => void api.toggleReaction(personaId, info.eventId, mark),
				},
				{
					label: "Reply",
					onClick: () => setReplyTo({ eventId: info.eventId, from: info.from, text: info.text }),
				},
				{ type: "divider" },
				{ label: "Copy Message", onClick: () => void api.writeClipboard(info.text) },
			],
		});
	};

	/* Peer threads keep the old copy-only menu: their events live in a
	 * different store, and a reaction there would have nowhere to go yet. */
	const onPeerMessageMenu = (text: string, event: ReactMouseEvent) => {
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
						beforeFooter={chromeOn ? undefined : instanceChip}
						onSearch={webClient() ? () => setSearchOpen(true) : undefined}
						onArrange={toad.arrangePersonas}
						onAddingChange={(next) => {
							setAddingTeam(undefined);
							setAdding(next);
						}}
						onAddToTeam={(team) => {
							setAddingTeam(team);
							setAdding(true);
						}}
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
							onBubbleActions={stack ? setBubbleSheet : undefined}
							onToggleReaction={(eventId, emoji) =>
								void api.toggleReaction(selected.id, eventId, emoji)
							}
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
							replyTo={
								replyTo && {
									eventId: replyTo.eventId,
									label: replyTo.from === "me" ? "yourself" : selected.name,
									text: replyTo.text,
								}
							}
							onClearReply={() => setReplyTo(null)}
							onDraftChange={(next) => toad.setDraft(selected.id, next)}
							onAttach={(added) => toad.addAttachments(selected.id, added)}
							onSend={(text, attachments, replyTo) =>
								void toad.send(selected.id, text, attachments, replyTo)
							}
							onSteer={(text, attachments, replyTo) =>
								void toad.steer(selected.id, text, attachments, replyTo)
							}
							onCancel={() => void toad.cancel(selected.id)}
						/>

						{dragging && (
							<div className="drop-veil" aria-hidden="true">
								<p className="drop-note">Drop to attach</p>
							</div>
						)}

						{bubbleSheet && (
							<BubbleSheet
								speaker={bubbleSheet.from === "me" ? "You" : selected.name}
								text={bubbleSheet.text}
								onReact={(emoji) => {
									void api.toggleReaction(selected.id, bubbleSheet.eventId, emoji);
									hapticTap();
								}}
								onReply={() => setReplyTo(bubbleSheet)}
								onCopy={() => void api.writeClipboard(bubbleSheet.text)}
								onClose={() => setBubbleSheet(null)}
							/>
						)}

					</main>
				</>
			)}

			{confirmDelete && (
				<ConfirmSheet
					title={`Remove ${confirmDelete.name}?`}
					detail="Their conversation and session history go too. This cannot be undone."
					action={`Remove ${confirmDelete.name}`}
					onConfirm={() => destroyTeammate(confirmDelete.id, true)}
					onClose={() => setConfirmDelete(null)}
				/>
			)}

			{/* Settings own a rail, so they cover the roster and conversation as one
			    window rather than leaving two rails side by side. */}
			{settings && webClient() && (
				<PhoneSettings
					scope={settings.scope === "teammate" && selected ? "teammate" : "app"}
					persona={selected}
					teams={Array.from(new Set(toad.personas.map((p) => p.team?.trim()).filter((t): t is string => Boolean(t))))}
					backends={toad.backends}
					info={sessionInfo}
					renameNonce={renameNonce}
					identityDraft={selected ? identityDrafts[selected.id] : undefined}
					desktopName={desktopName}
					onIdentityDraftChange={(personaId, draft) =>
						setIdentityDrafts((current) => {
							if (draft) return { ...current, [personaId]: draft };
							const { [personaId]: _gone, ...rest } = current;
							return rest;
						})
					}
					onPatchPersona={(patch) =>
						selected ? toad.patchPersona(selected.id, patch) : Promise.resolve(null)
					}
					onSwitchBackend={(backendId) =>
						selected ? toad.switchBackend(selected.id, backendId) : Promise.resolve()
					}
					onDeletePersona={() => {
						if (selected) deleteTeammate(selected.id);
					}}
					rooms={rooms}
					activeRoomKey={activeRoomKey}
					onSwitchRoom={onSwitchRoom}
					onJoinRoom={onJoinRoom}
					onManageDesktops={onManageDesktops}
					onClose={closeSettings}
				/>
			)}

			{settings && !webClient() && (
				<SettingsOverlay
					route={settings}
					narrow={narrow}
					persona={selected}
					teams={Array.from(new Set(toad.personas.map((p) => p.team?.trim()).filter((t): t is string => Boolean(t))))}
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
					remoteNodes={fleet.filter((roster) => roster.online).map((roster) => roster.node)}
					onCreatedRemote={() => setFleetNonce((n) => n + 1)}
					teams={Array.from(new Set(toad.personas.map((p) => p.team?.trim()).filter((t): t is string => Boolean(t))))}
					initialTeam={addingTeam}
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

			{searchOpen && (
				<GlobalSearch
					personas={toad.personas}
					onPick={(personaId, eventId) => {
						onMenuAction.current({ action: "selectTeammate", personaId });
						if (eventId) setFocus({ eventId, at: Date.now() });
						/* The phone jumped somewhere; the desk keeps the drawer for
						   the next result, the way the old per-thread search did. */
						if (webClient()) setSearchOpen(false);
					}}
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
					onMessageMenu={onPeerMessageMenu}
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
