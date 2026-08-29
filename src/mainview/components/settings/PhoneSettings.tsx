import { useEffect, useRef, useState, type ReactNode } from "react";
import { isUp } from "../../../shared/session";
import {
	composeFallbackFace,
	curateFace,
	FACE_HUES,
	FACE_PARTS,
	type Face,
} from "../../../shared/face";
import type {
	AppInfo,
	AppSettings,
	Backend,
	Containment,
	Persona,
	SessionInfo,
	SessionState,
} from "../../../shared/types";
import { hapticTap, hapticsOn, setHapticsOn } from "../../haptics";
import { bestDeskOf, type RoomEntry } from "../../instances/store";
import { api, on } from "../../rpc";
import { useEdgeSwipe } from "../../useEdgeSwipe";
import { FaceIcon } from "../FaceIcon";
import { RoomBadge } from "../RoomBadge";
import { Agent } from "./teammate/Agent";
import { Identity, type IdentityDraft } from "./teammate/Identity";
import { Schedule } from "./teammate/Schedule";
import { Session } from "./teammate/Session";
import { Workspace } from "./teammate/Workspace";
import { SubagentPane } from "./teammate/Subagents";
import { subagentDetail, type TeammateDetailId } from "./sections";

/* `isSubagentDetail` in sections.ts narrows from TeammateDetailId; here the
 * union is wider (screen ids), so the guard is restated over it. */
function isSubagentScreen(id: string): id is TeammateDetailId {
	return id === "subagent-new" || id.startsWith("subagent:");
}

/**
 * Settings as the phone tells it: a home screen of grouped cards pushed over
 * the app, with each section a screen of its own pushed over the home.
 *
 * The desktop's overlay-with-a-rail (SettingsOverlay) assumes a window wide
 * enough to hold a map and a territory at once. Here there is one thumb and
 * one column, so navigation is the platform's own: push, back, edge-swipe.
 *
 * The trim is deliberate. Tools and MCP configuration are desktop work — a
 * footnote says where they went. What remains answers before it is opened:
 * each row whispers its current value on the right.
 */

const SLIDE_MS = 240;

const STATE_LABEL: Record<SessionState, string> = {
	idle: "idle",
	starting: "starting",
	ready: "ready",
	thinking: "working",
	error: "error",
	stopped: "stopped",
};

type ScreenId =
	| "identity"
	| "agent"
	| "workspace"
	| "schedule"
	| "session"
	| "notifications"
	| "about"
	| TeammateDetailId;

type Props = {
	scope: "teammate" | "app";
	/** Required in teammate scope; the caller checks at the door. */
	persona: Persona | null;
	/** Every team label in use, for the Identity picker. */
	teams?: string[];
	backends: Backend[];
	info: SessionInfo | null;
	renameNonce: number;
	identityDraft: IdentityDraft | undefined;
	/** The desktop this phone is wired to, for the Desktops row. */
	desktopName?: string;
	/** The rooms this phone is joined to; the active one is checked. */
	rooms?: RoomEntry[];
	activeRoomKey?: string | null;
	onSwitchRoom?(key: string): void;
	onJoinRoom?(): void;
	onIdentityDraftChange(personaId: string, draft: IdentityDraft | undefined): void;
	onPatchPersona(patch: Partial<Persona>): Promise<unknown>;
	onSwitchBackend(backendId: string): Promise<unknown>;
	/* The session's disposition and lifecycle, here because this surface is the
	 * phone's only door to them — the toolbar sheet that used to hold them is
	 * gone. */
	onStartSession(): void;
	onStopSession(): void;
	onSetModel(modelId: string): void;
	onSetMode(modeId: string): void;
	onSetConfig(configId: string, value: string): void;
	onDeletePersona(): void;
	onManageDesktops?(): void;
	onClose(): void;
};

export function PhoneSettings({
	scope,
	persona,
	teams,
	backends,
	info,
	renameNonce,
	identityDraft,
	desktopName,
	rooms,
	activeRoomKey,
	onSwitchRoom,
	onJoinRoom,
	onIdentityDraftChange,
	onPatchPersona,
	onSwitchBackend,
	onStartSession,
	onStopSession,
	onSetModel,
	onSetMode,
	onSetConfig,
	onDeletePersona,
	onManageDesktops,
	onClose,
}: Props) {
	/* The whole surface slides over the app, and each opened section slides
	 * over it in turn. Leaving is the same move in reverse, so a screen that
	 * is going keeps rendering until its slide has finished. */
	const [open, setOpen] = useState(false);
	const [stack, setStack] = useState<ScreenId[]>([]);
	const [leaving, setLeaving] = useState<ScreenId | null>(null);
	const rootRef = useRef<HTMLDivElement>(null);
	const closing = useRef(false);

	useEffect(() => {
		const frame = requestAnimationFrame(() =>
			requestAnimationFrame(() => setOpen(true)),
		);
		return () => cancelAnimationFrame(frame);
	}, []);

	const requestClose = () => {
		if (closing.current) return;
		closing.current = true;
		setOpen(false);
		window.setTimeout(onClose, SLIDE_MS);
	};

	const push = (id: ScreenId) => setStack((current) => [...current, id]);
	const pop = () => {
		if (leaving) return;
		const top = stack[stack.length - 1];
		if (top === undefined) return;
		setLeaving(top);
		window.setTimeout(() => {
			setLeaving(null);
			setStack((now) => now.slice(0, -1));
		}, SLIDE_MS);
	};

	/* Rename… lands with the caret in the name field, which means landing on
	 * the Identity screen, not the home. */
	const lastNonce = useRef(renameNonce);
	useEffect(() => {
		if (renameNonce === lastNonce.current) return;
		lastNonce.current = renameNonce;
		if (scope === "teammate")
			setStack((current) =>
				current[current.length - 1] === "identity" ? current : [...current, "identity"],
			);
	}, [renameNonce, scope]);

	useEdgeSwipe(rootRef, stack.length === 0, requestClose);

	/* ---------------------------------------------------------- shared reads */
	const [jobs, setJobs] = useState<number | null>(null);
	useEffect(() => {
		if (scope !== "teammate" || !persona) return;
		let cancelled = false;
		void api.listSchedules(persona.id).then((list) => {
			if (!cancelled) setJobs(list.length);
		});
		const off = on("schedulesChanged", (all) => {
			setJobs(all.filter((job) => job.personaId === persona.id).length);
		});
		return () => {
			cancelled = true;
			off();
		};
	}, [scope, persona?.id]);

	/* The Workspace screen's approvals read, once per teammate/backend pair —
	 * the same discipline TeammatePane keeps on the desktop. */
	const [containment, setContainment] = useState<Containment | null>(null);
	useEffect(() => {
		if (scope !== "teammate" || !persona) return;
		let cancelled = false;
		setContainment(null);
		void api.getContainment(persona.backendId).then((next) => {
			if (!cancelled) setContainment(next);
		});
		return () => {
			cancelled = true;
		};
	}, [scope, persona?.id, persona?.backendId]);

	const [settings, setSettings] = useState<AppSettings | null>(null);
	const [appInfo, setAppInfo] = useState<AppInfo | null>(null);
	useEffect(() => {
		if (scope !== "app") return;
		let cancelled = false;
		void Promise.all([api.getAppSettings(), api.getAppInfo()]).then(([next, about]) => {
			if (cancelled) return;
			setSettings(next);
			setAppInfo(about);
		});
		return () => {
			cancelled = true;
		};
	}, [scope]);

	const update = (patch: Partial<AppSettings>) => {
		setSettings((current) => (current ? { ...current, ...patch } : current));
		void api.updateAppSettings(patch).then(setSettings);
	};

	const backendName = (id: string) =>
		backends.find((backend) => backend.id === id)?.name ?? id;

	/* The room Notifications and About both need to talk about: whichever one
	 * is active, or the jar's only room while a wire has not settled on one
	 * yet (the same fallback InstancesScreen uses for the same reason). */
	const activeRoom = (rooms ?? []).find((entry) => entry.key === activeRoomKey) ?? rooms?.[0] ?? null;

	if (scope === "teammate" && !persona) return null;

	/* ------------------------------------------------------------- screens */
	const screenTitle = (id: ScreenId): string => {
		if (id === "subagent-new") return "New subagent";
		if (isSubagentScreen(id)) return "Subagent";
		return (
			{
				identity: "Identity",
				agent: "Agent",
				workspace: "Workspace",
				schedule: "Schedule",
				session: "Session",
				notifications: "Notifications",
				about: "About",
			}[id as Exclude<ScreenId, TeammateDetailId>] ?? ""
		);
	};

	const screenBody = (id: ScreenId): ReactNode => {
		if (scope === "teammate" && persona) {
			if (isSubagentScreen(id))
				return (
					<SubagentPane
						persona={persona}
						models={info?.models ?? []}
						running={info ? isUp(info.state) : false}
						detail={id}
						onPatch={onPatchPersona}
						onBack={pop}
					/>
				);
			switch (id) {
				case "identity":
					return (
						<>
							<Identity
								persona={persona}
								teams={teams}
								draft={identityDraft}
								renameNonce={renameNonce}
								onDraftChange={(draft) => onIdentityDraftChange(persona.id, draft)}
								onSave={async (draft) => {
									await onPatchPersona({
										name: draft.name.trim() || persona.name,
										goal: draft.goal,
									});
									onIdentityDraftChange(persona.id, undefined);
								}}
							/>
							<FaceCard persona={persona} onPatch={onPatchPersona} />
						</>
					);
				case "agent":
					return (
						<Agent
							persona={persona}
							backends={backends}
							info={info}
							onSwitchBackend={onSwitchBackend}
							onEditSubagent={(kind) => push(subagentDetail(kind))}
							onAddSubagent={() => push("subagent-new")}
							live={{ onSetModel, onSetMode, onSetConfig }}
						/>
					);
				case "workspace":
					/* The pane hides its desktop-only acts itself: no directory
					 * picker and no reveal from a phone, but the path reads whole
					 * and the Desk field still moves the teammate between desks. */
					return (
						<Workspace
							persona={persona}
							backends={backends}
							containment={containment}
							running={info ? isUp(info.state) : false}
							onPatch={onPatchPersona}
							onPickWorkspace={async () => null}
							onReveal={() => {}}
						/>
					);
				case "schedule":
					return <Schedule personaId={persona.id} />;
				case "session":
					return (
						<Session
							info={info}
							personaId={persona.id}
							lifecycle={{
								running: info ? isUp(info.state) : false,
								onStart: onStartSession,
								onStop: onStopSession,
							}}
						/>
					);
			}
		}
		if (id === "notifications")
			return (
				<PhoneNotifications
					push={settings?.push}
					roomName={activeRoom?.name}
					onUpdate={(patch) => update({ push: { enabled: false, ...settings?.push, ...patch } })}
				/>
			);
		if (id === "about")
			return <PhoneAbout info={appInfo} desktopName={desktopName} room={activeRoom} />;
		return null;
	};

	const backLabel = scope === "teammate" && persona ? persona.name : "Settings";

	return (
		<div ref={rootRef} className="pset-root" data-open={open}>
			{/* ------------------------------------------------------- home */}
			<div
				className="pset-screen-frame"
				{...(stack.length > 0 ? ({ inert: "" } as Record<string, string>) : {})}
			>
				<header className="pset-nav safe-head">
					<button type="button" className="pset-back" onClick={requestClose}>
						<Chevron back />
						{scope === "teammate" && persona ? persona.name : "Team"}
					</button>
				</header>
				<div className="pset-scroll">
					{scope === "teammate" && persona ? (
						<TeammateHome
							persona={persona}
							info={info}
							jobs={jobs}
							backendName={backendName(persona.backendId)}
							onOpen={push}
							onDelete={onDeletePersona}
						/>
					) : (
						<AppHome
							settings={settings}
							rooms={rooms}
							activeRoomKey={activeRoomKey}
							onSwitchRoom={(key) => {
								onSwitchRoom?.(key);
								requestClose();
							}}
							onJoinRoom={() => {
								requestClose();
								onJoinRoom?.();
							}}
							onOpen={push}
							onManageDesktops={() => {
								requestClose();
								onManageDesktops?.();
							}}
						/>
					)}
				</div>
			</div>

			{/* ---------------------------------------------------- pushed */}
			{stack.map((id, index) => (
				<PushedScreen
					key={`${id}-${index}`}
					open={leaving !== id || index !== stack.length - 1}
					active={index === stack.length - 1 && leaving === null}
					title={screenTitle(id)}
					backLabel={index === 0 ? backLabel : screenTitle(stack[index - 1])}
					onBack={pop}
				>
					{screenBody(id)}
				</PushedScreen>
			))}
		</div>
	);
}

/* ------------------------------------------------------------------ pieces */

function Chevron({ back }: { back?: boolean }) {
	return (
		<svg
			viewBox="0 0 11 19"
			className={back ? "pset-chev-back" : "pset-chev"}
			fill="none"
			stroke="currentColor"
			strokeWidth={2.4}
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
		>
			{back ? <path d="M9.5 1.5 2 9.5l7.5 8" /> : <path d="M1.5 1.5 9 9.5l-7.5 8" />}
		</svg>
	);
}

function PushedScreen({
	open,
	active,
	title,
	backLabel,
	onBack,
	children,
}: {
	open: boolean;
	active: boolean;
	title: string;
	backLabel: string;
	onBack(): void;
	children: ReactNode;
}) {
	const [entered, setEntered] = useState(false);
	const ref = useRef<HTMLDivElement>(null);
	useEffect(() => {
		const frame = requestAnimationFrame(() =>
			requestAnimationFrame(() => setEntered(true)),
		);
		return () => cancelAnimationFrame(frame);
	}, []);
	useEdgeSwipe(ref, active, onBack);
	return (
		<div
			ref={ref}
			className="pset-screen-frame pset-pushed"
			data-open={entered && open}
			{...(active ? {} : ({ inert: "" } as Record<string, string>))}
		>
			<header className="pset-nav safe-head">
				<button type="button" className="pset-back" onClick={onBack}>
					<Chevron back />
					{backLabel}
				</button>
				<h2 className="pset-title">{title}</h2>
			</header>
			<div className="pset-scroll pset-pane">{children}</div>
		</div>
	);
}

function Row({
	icon,
	tint,
	label,
	detail,
	accentDetail,
	onClick,
	control,
}: {
	icon: ReactNode;
	tint?: boolean;
	label: string;
	detail?: string;
	accentDetail?: boolean;
	onClick?(): void;
	control?: ReactNode;
}) {
	const body = (
		<>
			<span className={`pset-tile${tint ? " pset-tile-tint" : ""}`}>{icon}</span>
			<span className="pset-row-label">{label}</span>
			{detail && (
				<span className={`pset-row-detail${accentDetail ? " ok" : ""}`}>{detail}</span>
			)}
			{control ?? (onClick && <Chevron />)}
		</>
	);
	return onClick ? (
		<button type="button" className="pset-row" onClick={onClick}>
			{body}
		</button>
	) : (
		<div className="pset-row">{body}</div>
	);
}

function TeammateHome({
	persona,
	info,
	jobs,
	backendName,
	onOpen,
	onDelete,
}: {
	persona: Persona;
	info: SessionInfo | null;
	jobs: number | null;
	backendName: string;
	onOpen(id: ScreenId): void;
	onDelete(): void;
}) {
	const face = persona.face ?? composeFallbackFace(persona.name, persona.goal);
	const state = info?.state ?? "idle";
	return (
		<>
			<div className="pset-hero">
				<FaceIcon face={face} size={92} />
				<h1 className="pset-hero-name">{persona.name}</h1>
				<p className="pset-hero-sub">
					<span className={`pset-vital${state === "thinking" || state === "ready" ? " on" : ""}`} />
					{STATE_LABEL[state]} · {backendName}
				</p>
			</div>

			<div className="pset-card">
				<Row
					tint
					icon={<IconPerson />}
					label="Identity"
					detail="name & brief"
					onClick={() => onOpen("identity")}
				/>
				<Row icon={<IconAgent />} label="Agent" detail={backendName} onClick={() => onOpen("agent")} />
				<Row
					icon={<IconFolder />}
					label="Workspace"
					detail={persona.cwd.split("/").filter(Boolean).pop() ?? ""}
					onClick={() => onOpen("workspace")}
				/>
				<Row
					icon={<IconClock />}
					label="Schedule"
					detail={jobs === null ? "" : jobs === 0 ? "none" : `${jobs} job${jobs === 1 ? "" : "s"}`}
					onClick={() => onOpen("schedule")}
				/>
			</div>

			<div className="pset-card">
				<Row
					icon={<IconRestore />}
					label="Session"
					detail="chapters"
					onClick={() => onOpen("session")}
				/>
			</div>

			<div className="pset-card">
				<button type="button" className="pset-row pset-row-danger" onClick={onDelete}>
					<span className="pset-row-label">Remove from team…</span>
				</button>
			</div>
			<p className="pset-foot">Tools are configured on the desktop that runs this teammate.</p>
		</>
	);
}

function AppHome({
	settings,
	rooms,
	activeRoomKey,
	onSwitchRoom,
	onJoinRoom,
	onOpen,
	onManageDesktops,
}: {
	settings: AppSettings | null;
	rooms: RoomEntry[] | undefined;
	activeRoomKey: string | null | undefined;
	onSwitchRoom(key: string): void;
	onJoinRoom(): void;
	onOpen(id: ScreenId): void;
	onManageDesktops(): void;
}) {
	const [touch, setTouch] = useState(hapticsOn());
	/* The phone's own version, for the About row.
	 *
	 * The row used to preview `appInfo.version` — the *desk's* Toad — under a
	 * heading reading "Toad", while the screen it opens leads with the phone's
	 * `1.0 (1)`. A row that answers a different question than the screen behind
	 * it is worse than a row that answers nothing, so this asks the shell the
	 * same way `PhoneAbout` does and shows an empty detail until it answers
	 * (D4). The desk's version still lives inside About, as room detail. */
	const [shellVersion, setShellVersion] = useState("");
	useEffect(() => {
		let cancelled = false;
		void import("@capacitor/app")
			.then(({ App }) => App.getInfo())
			.then((got) => {
				if (!cancelled) setShellVersion(`${got.version} (${got.build})`);
			})
			// A browser has no shell to ask; the row simply carries no preview.
			.catch(() => {});
		return () => {
			cancelled = true;
		};
	}, []);

	return (
		<>
			{/* Rooms first: the room is the app's most important object, and the
			    only row here that opens a screen about the world rather than a
			    preference. */}
			<p className="pset-label">Rooms</p>
			<div className="pset-card">
				{(rooms ?? []).map((room) => (
					<RoomRow
						key={room.key}
						room={room}
						active={room.key === activeRoomKey}
						onClick={room.key === activeRoomKey ? onManageDesktops : () => onSwitchRoom(room.key)}
					/>
				))}
				<Row icon={<IconRoom />} label="Join a room" onClick={onJoinRoom} />
			</div>
			<p className="pset-foot">
				A room is your whole team, from any of its desktops — the app finds a healthy one on its
				own. Tap a room to switch; tap the active one to open it.
			</p>

			{/* Notifications is not a phone setting. The switches live in the room's
			    shared app settings and every desk holding a push key honours them,
			    which is exactly what "THIS PHONE" promised it was not (D1). */}
			<p className="pset-label">Room-wide</p>
			<div className="pset-card">
				<Row
					icon={<IconBell />}
					label="Notifications"
					detail={settings?.push?.enabled ? "on" : "off"}
					onClick={() => onOpen("notifications")}
				/>
			</div>
			<p className="pset-foot">
				Shared across the room — any of its desktops can buzz this phone.
			</p>

			<p className="pset-label">This phone</p>
			<div className="pset-card">
				<Row
					icon={<IconBuzz />}
					label="Haptics"
					control={
						<Switch
							on={touch}
							label="Haptics"
							onToggle={() => {
								const next = !touch;
								setHapticsOn(next);
								setTouch(next);
								if (next) hapticTap();
							}}
						/>
					}
				/>
				<Row
					icon={<IconInfo />}
					label="About"
					detail={shellVersion}
					onClick={() => onOpen("about")}
				/>
			</div>
			<p className="pset-foot">
				Agents, tools, storage, and push signing are configured on the desktop that owns them.
			</p>
		</>
	);
}

/**
 * A room in the Rooms list.
 *
 * Two lines rather than a label with a value beside it, because the value is
 * a desktop's name and `.pset-row-detail` clips at 45% of the row — which is
 * how "via Georges-Mac-mini" shipped as "via Georges-Mac…", cutting off the
 * one piece of connection detail the row was carrying (D2). The badge makes
 * the room recognisable before the name is read; the wire dot stays a
 * separate mark from the badge's hue, because hue is identity and the dot is
 * health, and a room that was moss-coloured would look connected always.
 */
function RoomRow({
	room,
	active,
	onClick,
}: {
	room: RoomEntry;
	active: boolean;
	onClick(): void;
}) {
	const desk = bestDeskOf(room);
	const caption = active
		? `via ${desk?.name ?? "…"}`
		: room.direct
			? "direct link"
			: `${room.desks.length} desktop${room.desks.length === 1 ? "" : "s"}`;
	return (
		<button type="button" className="pset-row" onClick={onClick}>
			<RoomBadge roomId={room.key} name={room.name} />
			<span className="pset-row-stack">
				<span className="pset-row-name">{room.name}</span>
				<span className={`pset-row-cap${active ? " ok" : ""}`}>{caption}</span>
			</span>
			{/* Decorative: "via <desk>" on the line above already says, in words,
			    the thing the dot is saying in colour. */}
			{active && <span className="pset-vital on" aria-hidden="true" />}
			<Chevron />
		</button>
	);
}

function Switch({ on, label, onToggle }: { on: boolean; label: string; onToggle(): void }) {
	return (
		<button
			type="button"
			role="switch"
			aria-checked={on}
			aria-label={label}
			className={`pset-switch${on ? " on" : ""}`}
			onClick={onToggle}
		>
			<i />
		</button>
	);
}

/**
 * The buzz preferences, phone-sized. The `.p8` that signs pushes stays a
 * desktop matter; these switches are the shared app settings, so flipping one
 * here flips it everywhere — act where you tap.
 */
function PhoneNotifications({
	push,
	roomName,
	onUpdate,
}: {
	push: AppSettings["push"];
	/** For the foot's "any desktop in <room>" — unnamed only while the jar is empty. */
	roomName?: string;
	onUpdate(patch: Partial<NonNullable<AppSettings["push"]>>): void;
}) {
	const enabled = push?.enabled ?? false;
	const kinds: Array<{
		key: "turnEnded" | "permission" | "blocked";
		label: string;
	}> = [
		{ key: "turnEnded", label: "Finishes a turn" },
		{ key: "permission", label: "Needs you" },
		{ key: "blocked", label: "Hits an error" },
	];
	return (
		<div className="flex flex-col">
			<div className="pset-card">
				<Row
					tint
					icon={<IconBell />}
					label="Send buzzes"
					control={
						<Switch on={enabled} label="Send buzzes" onToggle={() => onUpdate({ enabled: !enabled })} />
					}
				/>
			</div>
			<p className="pset-label">Buzz when a teammate</p>
			<div className={`pset-card${enabled ? "" : " pset-dim"}`}>
				{kinds.map(({ key, label }) => {
					const value = push?.[key] ?? true;
					return (
						<Row
							key={key}
							icon={<IconDot />}
							label={label}
							control={
								<Switch
									on={value && enabled}
									label={label}
									onToggle={() => enabled && onUpdate({ [key]: !value })}
								/>
							}
						/>
					);
				})}
			</div>
			<p className="pset-foot">
				Any desktop in {roomName || "your room"} can send these. The switches are shared across the
				room, so every desktop honors them.
			</p>
		</div>
	);
}

/**
 * Two subjects, kept apart: this phone (its own version and key fingerprint,
 * from the native shell) and the room it is in (badge, name, size, and the
 * desktop it currently rides — whose facts arrive over the wire and are
 * labeled as the room's detail, not passed off as the phone's own).
 *
 * A bare hostname used to head its own section here, level with "This
 * phone" and with the room never named at all — on the one screen meant to
 * explain what this app is attached to (G1). The room takes that billing
 * now; the desktop is a line inside it.
 */
function PhoneAbout({
	info,
	desktopName,
	room,
}: {
	info: AppInfo | null;
	desktopName?: string;
	/** The room this screen is About; null only before the jar has settled. */
	room: RoomEntry | null;
}) {
	const [shell, setShell] = useState<{ version: string; build: string } | null>(null);
	/* The plane identity, shown as the same four fingerprint groups a desktop
	 * prints — what someone reads aloud to confirm it is *this* phone that a
	 * desk's Phones list is naming. "Key fingerprint" everywhere (G2): the
	 * desktop's Room pane calls the same value that, not "Node key". */
	const [fingerprint, setFingerprint] = useState("");
	useEffect(() => {
		let cancelled = false;
		void import("@capacitor/app")
			.then(({ App }) => App.getInfo())
			.then((got) => {
				if (!cancelled) setShell({ version: got.version, build: got.build });
			})
			.catch(() => {});
		void import("../../node-identity")
			.then(({ mobileIdentity }) => mobileIdentity())
			.then((node) => {
				if (!cancelled) {
					setFingerprint(node.fingerprint.match(/.{1,4}/g)?.slice(0, 4).join(" ") ?? "");
				}
			})
			.catch(() => {});
		return () => {
			cancelled = true;
		};
	}, []);
	return (
		<>
			<p className="pset-label">This phone</p>
			<div className="pset-card">
				<Row
					icon={<IconInfo />}
					label="Version"
					detail={shell ? `${shell.version} (${shell.build})` : ""}
				/>
				{fingerprint && <Row icon={<IconDot />} label="Key fingerprint" detail={fingerprint} />}
			</div>
			<p className="pset-label">{room?.name || "Room"}</p>
			<div className="pset-card">
				<div className="pset-row">
					<RoomBadge roomId={room?.key ?? "room"} name={room?.name || "Room"} />
					<span className="pset-row-stack">
						<span className="pset-row-name">{room?.name || "Room"}</span>
						<span className="pset-row-cap">
							{room ? `${room.desks.length} desktop${room.desks.length === 1 ? "" : "s"}` : ""}
						</span>
					</span>
				</div>
				<Row
					icon={<IconDesktop />}
					label="Connected via"
					detail={desktopName ? `${desktopName} · Toad ${info?.version || "unreleased build"}` : ""}
				/>
			</div>
		</>
	);
}

/**
 * The face, owned. Shuffle deals a whole new one — hue, body, eyes, the lot —
 * through the same curation the agent's own choice passes through.
 */
function FaceCard({
	persona,
	onPatch,
}: {
	persona: Persona;
	onPatch(patch: Partial<Persona>): Promise<unknown>;
}) {
	const [face, setFace] = useState<Face>(
		persona.face ?? composeFallbackFace(persona.name, persona.goal),
	);
	const pick = <T,>(list: readonly T[]): T => list[Math.floor(Math.random() * list.length)];
	const shuffle = () => {
		const next = curateFace({
			v: 1,
			hue: pick(FACE_HUES),
			body: pick(FACE_PARTS.body),
			eyes: pick(FACE_PARTS.eyes),
			mouth: pick(FACE_PARTS.mouth),
			hat: pick(FACE_PARTS.hat),
			marks: pick(FACE_PARTS.marks),
			pattern: pick(FACE_PARTS.pattern),
		});
		setFace(next);
		hapticTap();
		void onPatch({ face: next });
	};
	return (
		<div className="pset-card pset-face-card">
			<FaceIcon face={face} size={62} />
			<div className="flex min-w-0 flex-1 flex-col items-start gap-xs">
				<p className="text-sm text-ink-2">The same face, every launch.</p>
				<button type="button" className="pset-shuffle" onClick={shuffle}>
					<IconShuffle />
					Shuffle
				</button>
			</div>
		</div>
	);
}

/* --------------------------------------------------------------- icon set
 * Sized for the 30px tile; stroke weight matches the app's other glyphs. */

const tile = {
	width: 16,
	height: 16,
	viewBox: "0 0 24 24",
	fill: "none",
	stroke: "currentColor",
	strokeWidth: 1.9,
	strokeLinecap: "round",
	strokeLinejoin: "round",
	"aria-hidden": true,
} as const;

const IconPerson = () => (
	<svg {...tile}>
		<circle cx="12" cy="8" r="4.2" />
		<path d="M4.5 20.5c.8-4 3.9-6 7.5-6s6.7 2 7.5 6" />
	</svg>
);
const IconAgent = () => (
	<svg {...tile}>
		<rect x="4" y="7" width="16" height="12" rx="2.5" />
		<path d="M12 7V4.2M8.5 13h.01M15.5 13h.01" />
	</svg>
);
const IconFolder = () => (
	<svg {...tile}>
		<path d="M3 7.2c0-1.2.9-2.2 2.1-2.2h4.1l2 2.3h7.7c1.2 0 2.1 1 2.1 2.2v8.3c0 1.2-.9 2.2-2.1 2.2H5.1C3.9 20 3 19 3 17.8Z" />
	</svg>
);
const IconClock = () => (
	<svg {...tile}>
		<circle cx="12" cy="12" r="8.6" />
		<path d="M12 7.2V12l3.2 2.1" />
	</svg>
);
const IconRestore = () => (
	<svg {...tile}>
		<path d="M4.5 12a7.5 7.5 0 1 1 2.2 5.3M4.5 12V7.5M4.5 12H9" />
	</svg>
);
const IconBell = () => (
	<svg {...tile}>
		<path d="M18.2 8.2a6.2 6.2 0 0 0-12.4 0c0 6.8-2.3 8.3-2.3 8.3h17s-2.3-1.5-2.3-8.3ZM10 19.7a2.15 2.15 0 0 0 4 0" />
	</svg>
);
const IconBuzz = () => (
	<svg {...tile}>
		<rect x="8" y="2.5" width="8" height="19" rx="2.4" />
		<path d="M2.8 8.5a12 12 0 0 1 0 7M21.2 8.5a12 12 0 0 0 0 7" />
	</svg>
);
const IconDesktop = () => (
	<svg {...tile}>
		<rect x="2.5" y="4.5" width="19" height="13" rx="2.4" />
		<path d="M9 20.5h6M12 17.5v3" />
	</svg>
);
const IconRoom = () => (
	<svg {...tile}>
		<rect x="3" y="5" width="8" height="6" rx="1.6" />
		<rect x="13" y="13" width="8" height="6" rx="1.6" />
		<path d="M11 8h4v5M9 11v5H5" opacity="0.5" />
	</svg>
);
const IconInfo = () => (
	<svg {...tile}>
		<circle cx="12" cy="12" r="8.6" />
		<path d="M12 11v5.5M12 7.6v.4" />
	</svg>
);
const IconDot = () => (
	<svg {...tile}>
		<circle cx="12" cy="12" r="2.6" fill="currentColor" stroke="none" />
	</svg>
);
const IconShuffle = () => (
	<svg {...tile} width={15} height={15} strokeWidth={2}>
		<path d="M3.5 6.5h4L16 17.5h4.5m0 0-3-3m3 3-3 3M3.5 17.5h4M16 6.5h4.5m0 0-3-3m3 3-3 3" />
	</svg>
);
