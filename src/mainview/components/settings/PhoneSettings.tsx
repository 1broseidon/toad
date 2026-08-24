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
	Persona,
	SessionInfo,
	SessionState,
} from "../../../shared/types";
import { hapticTap, hapticsOn, setHapticsOn } from "../../haptics";
import { api, on } from "../../rpc";
import { useEdgeSwipe } from "../../useEdgeSwipe";
import { FaceIcon } from "../FaceIcon";
import { Agent } from "./teammate/Agent";
import { Identity, type IdentityDraft } from "./teammate/Identity";
import { Schedule } from "./teammate/Schedule";
import { Session } from "./teammate/Session";
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
 * The trim is deliberate. Tools, Workspace, and MCP configuration are desktop
 * work — a footnote says where they went. What remains answers before it is
 * opened: each row whispers its current value on the right.
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
	| "schedule"
	| "session"
	| "notifications"
	| "about"
	| TeammateDetailId;

type Props = {
	scope: "teammate" | "app";
	/** Required in teammate scope; the caller checks at the door. */
	persona: Persona | null;
	backends: Backend[];
	info: SessionInfo | null;
	renameNonce: number;
	identityDraft: IdentityDraft | undefined;
	/** The desktop this phone is wired to, for the Desktops row. */
	desktopName?: string;
	onIdentityDraftChange(personaId: string, draft: IdentityDraft | undefined): void;
	onPatchPersona(patch: Partial<Persona>): Promise<unknown>;
	onSwitchBackend(backendId: string): Promise<unknown>;
	onDeletePersona(): void;
	onManageDesktops?(): void;
	onClose(): void;
};

export function PhoneSettings({
	scope,
	persona,
	backends,
	info,
	renameNonce,
	identityDraft,
	desktopName,
	onIdentityDraftChange,
	onPatchPersona,
	onSwitchBackend,
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

	if (scope === "teammate" && !persona) return null;

	/* ------------------------------------------------------------- screens */
	const screenTitle = (id: ScreenId): string => {
		if (id === "subagent-new") return "New subagent";
		if (isSubagentScreen(id)) return "Subagent";
		return (
			{
				identity: "Identity",
				agent: "Agent",
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
						/>
					);
				case "schedule":
					return <Schedule personaId={persona.id} />;
				case "session":
					return <Session info={info} personaId={persona.id} />;
			}
		}
		if (id === "notifications")
			return (
				<PhoneNotifications
					push={settings?.push}
					onUpdate={(patch) => update({ push: { enabled: false, ...settings?.push, ...patch } })}
				/>
			);
		if (id === "about") return <PhoneAbout info={appInfo} />;
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
							appInfo={appInfo}
							desktopName={desktopName}
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
			<p className="pset-foot">Tools, Workspace, and MCP live on the desktop.</p>
		</>
	);
}

function AppHome({
	settings,
	appInfo,
	desktopName,
	onOpen,
	onManageDesktops,
}: {
	settings: AppSettings | null;
	appInfo: AppInfo | null;
	desktopName: string | undefined;
	onOpen(id: ScreenId): void;
	onManageDesktops(): void;
}) {
	const [touch, setTouch] = useState(hapticsOn());
	return (
		<>
			<p className="pset-label">This phone</p>
			<div className="pset-card">
				<Row
					tint
					icon={<IconBell />}
					label="Notifications"
					detail={settings?.push?.enabled ? "on" : "off"}
					onClick={() => onOpen("notifications")}
				/>
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
			</div>

			<p className="pset-label">Desktops</p>
			<div className="pset-card">
				<Row
					icon={<IconDesktop />}
					label={desktopName ?? "Desktops"}
					detail="active"
					accentDetail
					onClick={onManageDesktops}
				/>
			</div>

			<p className="pset-label">Toad</p>
			<div className="pset-card">
				<Row
					icon={<IconInfo />}
					label="About"
					detail={appInfo?.version || ""}
					onClick={() => onOpen("about")}
				/>
			</div>
			<p className="pset-foot">
				Agents, MCP servers, storage, and push signing are configured on the desktop.
			</p>
		</>
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
	onUpdate,
}: {
	push: AppSettings["push"];
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
				Your desktop signs and sends every buzz. These switches are shared with it.
			</p>
		</div>
	);
}

function PhoneAbout({ info }: { info: AppInfo | null }) {
	return (
		<div className="pset-card">
			<Row icon={<IconInfo />} label="Version" detail={info?.version || "unreleased build"} />
			<Row icon={<IconDot />} label="Channel" detail={info?.channel || "dev"} />
			{info?.identifier && <Row icon={<IconDot />} label="Identifier" detail={info.identifier} />}
		</div>
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
