import { useEffect, useState } from "react";
import type {
	AppInfo,
	AppSettings as AppPreferences,
	Backend,
	Containment,
	Persona,
	SessionInfo,
} from "../../../shared/types";
import { api } from "../../rpc";
import { Toolbar } from "../Toolbar";
import { CloseIcon, RosterIcon } from "../icons";
import { About } from "./app/About";
import { Backends } from "./app/Backends";
import { General } from "./app/General";
import { Storage } from "./app/Storage";
import { SettingsRail } from "./SettingsRail";
import {
	type AppSectionId,
	APP_SECTIONS,
	type SettingsRoute,
	type TeammateSectionId,
	TEAMMATE_SECTIONS,
	titleOf,
} from "./sections";
import { Agent } from "./teammate/Agent";
import { Danger } from "./teammate/Danger";
import { Identity } from "./teammate/Identity";
import { Session } from "./teammate/Session";
import { Workspace } from "./teammate/Workspace";

export type IdentityDraft = { name: string; goal: string };

type Props = {
	route: SettingsRoute;
	/** True once the window is too narrow to hold the rail beside the pane. */
	narrow: boolean;
	/** Null only in app scope; teammate scope is not reachable without one. */
	persona: Persona | null;
	backends: Backend[];
	info: SessionInfo | null;
	/** Changes when Rename… is chosen from a menu, which takes the caret. */
	renameNonce: number;
	identityDraft: IdentityDraft | undefined;
	onIdentityDraftChange(personaId: string, draft: IdentityDraft | undefined): void;
	onRoute(route: SettingsRoute): void;
	onClose(): void;
	onPatchPersona(patch: Partial<Persona>): Promise<unknown>;
	onDeletePersona(): void;
	onPickWorkspace(): Promise<string | null>;
	onRevealWorkspace(): void;
	onRefreshBackends(): Promise<unknown>;
};

export function SettingsOverlay({
	route,
	narrow,
	persona,
	backends,
	info,
	renameNonce,
	identityDraft,
	onIdentityDraftChange,
	onRoute,
	onClose,
	onPatchPersona,
	onDeletePersona,
	onPickWorkspace,
	onRevealWorkspace,
	onRefreshBackends,
}: Props) {
	const [sectionRailOpen, setSectionRailOpen] = useState(false);
	const [railScrolled, setRailScrolled] = useState(false);
	const [paneScrolled, setPaneScrolled] = useState(false);
	const [containment, setContainment] = useState<Containment | null>(null);
	const [appSettings, setAppSettings] = useState<AppPreferences | null>(null);
	const [appInfo, setAppInfo] = useState<AppInfo | null>(null);
	const [refreshing, setRefreshing] = useState(false);
	const scrolled = railScrolled || paneScrolled;

	/* Widening puts the rail back in the layout. Keeping its drawer state would
	 * make it spring open again if the window crossed the threshold twice. */
	useEffect(() => {
		if (!narrow) setSectionRailOpen(false);
	}, [narrow]);

	/* Read once per teammate/backend pair rather than when Workspace mounts.
	 * Section visits are navigation, not a request to re-read an external file. */
	useEffect(() => {
		if (route.scope !== "teammate" || !persona) return;
		let cancelled = false;
		setContainment(null);
		void api.getContainment(persona.backendId).then((next) => {
			if (!cancelled) setContainment(next);
		});
		return () => {
			cancelled = true;
		};
	}, [route.scope, persona?.id, persona?.backendId]);

	/* One copy feeds General, Storage and About. Keeping it in the frame means
	 * moving between those sections does not turn navigation into another read. */
	useEffect(() => {
		if (route.scope !== "app") return;
		let cancelled = false;
		void Promise.all([api.getAppSettings(), api.getAppInfo()]).then(([settings, about]) => {
			if (cancelled) return;
			setAppSettings(settings);
			setAppInfo(about);
		});
		return () => {
			cancelled = true;
		};
	}, [route.scope]);

	useEffect(() => {
		if (route.scope === "teammate" && persona === null) onClose();
	}, [route.scope, persona, onClose]);

	if (route.scope === "teammate" && persona === null) return null;

	const scopeName = route.scope === "teammate" ? persona!.name : "Toad";
	const showSectionRail = !narrow || sectionRailOpen;
	const select = (section: string) => {
		const known =
			route.scope === "teammate"
				? TEAMMATE_SECTIONS.some((entry) => entry.id === section)
				: APP_SECTIONS.some((entry) => entry.id === section);
		if (!known) return;
		onRoute(
			route.scope === "teammate"
				? { scope: "teammate", section: section as TeammateSectionId }
				: { scope: "app", section: section as AppSectionId },
		);
		if (narrow) setSectionRailOpen(false);
	};

	const refresh = async () => {
		setRefreshing(true);
		try {
			await onRefreshBackends();
		} finally {
			setRefreshing(false);
		}
	};

	const updateAppSettings = (patch: Partial<AppPreferences>) => {
		/* Optimistic, because the write is a local file and the select snapping
		 * back to its old value reads as a broken control. */
		setAppSettings((current) => (current ? { ...current, ...patch } : current));
		void api.updateAppSettings(patch).then(setAppSettings);
	};

	const sectionContent =
		route.scope === "teammate"
			? teammateSection(route.section, {
					persona: persona!,
					backends,
					info,
					containment,
					renameNonce,
					identityDraft,
					onIdentityDraftChange,
					onPatchPersona,
					onDeletePersona,
					onPickWorkspace,
					onRevealWorkspace,
				})
			: appSection(route.section, {
					backends,
					settings: appSettings,
					info: appInfo,
					refreshing,
					onRefresh: () => void refresh(),
					onUpdateSettings: updateAppSettings,
				});

	return (
		<div className="absolute inset-0 z-overlay flex animate-fade-in bg-paper-2">
			{showSectionRail && (
				<SettingsRail
					route={route}
					scopeName={scopeName}
					drawer={narrow}
					scrolled={scrolled}
					hasSelected={persona !== null}
					onScrollEdge={setRailScrolled}
					onSelect={select}
					onBack={onClose}
				/>
			)}

			{narrow && sectionRailOpen && (
				<button
					type="button"
					aria-label="Hide sections"
					className="scrim animate-fade-in"
					onClick={() => setSectionRailOpen(false)}
				/>
			)}

			<section className={`relative flex min-w-0 flex-1 flex-col bg-paper ${curveOf(narrow)}`}>
				<Toolbar
					as="header"
					scrolled={scrolled}
					className={`gap-xs pr-2xs ${narrow ? "pl-lights" : "pl-gutter"}`}
				>
					{narrow && (
						<button
							type="button"
							className="btn-ghost -ml-3xs shrink-0 !px-xs"
							aria-label="Show sections"
							title="Show sections"
							onClick={() => setSectionRailOpen(true)}
						>
							<RosterIcon />
						</button>
					)}
					<h2 className="min-w-0 flex-1 truncate text-sm font-medium text-ink">
						{scopeName} · {titleOf(route)}
					</h2>
					<button
						type="button"
						className="btn-ghost w-6 !px-0"
						aria-label="Close settings"
						title="Done (Esc)"
						onClick={onClose}
					>
						<CloseIcon />
					</button>
				</Toolbar>

				<div
					className="flex-1 overflow-y-auto px-gutter py-xl"
					onScroll={(event) => setPaneScrolled(event.currentTarget.scrollTop > 0)}
				>
					<div className="mx-auto flex w-full max-w-settings flex-col gap-2xl">
						{sectionContent}
					</div>
				</div>
			</section>
		</div>
	);
}

type TeammateSectionProps = {
	persona: Persona;
	backends: Backend[];
	info: SessionInfo | null;
	containment: Containment | null;
	renameNonce: number;
	identityDraft: IdentityDraft | undefined;
	onIdentityDraftChange(personaId: string, draft: IdentityDraft | undefined): void;
	onPatchPersona(patch: Partial<Persona>): Promise<unknown>;
	onDeletePersona(): void;
	onPickWorkspace(): Promise<string | null>;
	onRevealWorkspace(): void;
};

function teammateSection(section: TeammateSectionId, props: TeammateSectionProps) {
	switch (section) {
		case "identity":
			return (
				<Identity
					persona={props.persona}
					draft={props.identityDraft}
					renameNonce={props.renameNonce}
					onDraftChange={(draft) => props.onIdentityDraftChange(props.persona.id, draft)}
					onSave={async (draft) => {
						await props.onPatchPersona({
							name: draft.name.trim() || props.persona.name,
							goal: draft.goal,
						});
						props.onIdentityDraftChange(props.persona.id, undefined);
					}}
				/>
			);
		case "agent":
			return (
				<Agent
					persona={props.persona}
					backends={props.backends}
					info={props.info}
					onPatch={props.onPatchPersona}
				/>
			);
		case "workspace":
			return (
				<Workspace
					persona={props.persona}
					backends={props.backends}
					containment={props.containment}
					running={props.info?.state === "ready" || props.info?.state === "thinking"}
					onPatch={props.onPatchPersona}
					onPickWorkspace={props.onPickWorkspace}
					onReveal={props.onRevealWorkspace}
				/>
			);
		case "session":
			return <Session info={props.info} />;
		case "danger":
			return <Danger onDelete={props.onDeletePersona} />;
	}
}

type AppSectionProps = {
	backends: Backend[];
	settings: AppPreferences | null;
	info: AppInfo | null;
	refreshing: boolean;
	onRefresh(): void;
	onUpdateSettings(patch: Partial<AppPreferences>): void;
};

function appSection(section: AppSectionId, props: AppSectionProps) {
	switch (section) {
		case "general":
			return (
				<General
					backends={props.backends}
					settings={props.settings}
					onUpdateSettings={props.onUpdateSettings}
				/>
			);
		case "backends":
			return (
				<Backends
					backends={props.backends}
					refreshing={props.refreshing}
					onRefresh={props.onRefresh}
				/>
			);
		case "storage":
			return <Storage info={props.info} />;
		case "about":
			return <About info={props.info} />;
	}
}

/**
 * How the conversation and settings panes are cut out of the window.
 *
 * At full width the rail is the shell and the content is a panel set into it:
 * the pane rounds the corners it shares with the rail and the rail's surface
 * shows through the notch, so the two read as one piece rather than as two
 * columns butted together.
 *
 * Narrow, there is no curve at all — the pane holds the window's own edge, and
 * rounding that is a chip out of the corner rather than a join.
 *
 * The clipping is what makes it work: the toolbar's band, its hairline, and
 * everything laid inside the pane have to be cut by the same curve.
 */
export function curveOf(narrow: boolean): string {
	return narrow ? "" : "overflow-hidden rounded-l-xl border-l border-rule";
}
