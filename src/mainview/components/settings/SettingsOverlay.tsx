import { useEffect, useState } from "react";
import type { Backend, Persona, SessionInfo } from "../../../shared/types";
import { insetLights } from "../../platform";
import { Toolbar } from "../Toolbar";
import { CloseIcon, RosterIcon } from "../icons";
import { AppPane } from "./AppPane";
import { SettingsRail } from "./SettingsRail";
import { TeammatePane } from "./TeammatePane";
import {
	type AppDetailId,
	type AppSectionId,
	APP_SECTIONS,
	type SettingsRoute,
	type TeammateDetailId,
	type TeammateSectionId,
	TEAMMATE_SECTIONS,
	titleOf,
} from "./sections";
import type { IdentityDraft } from "./teammate/Identity";

/**
 * Settings, as a window of its own laid over the one behind it.
 *
 * The frame is all this owns: the section rail, the band across the top, and
 * the column the sections are read in. What is being configured — a teammate or
 * Toad itself — lives in the two panes, each with its own reads to do.
 */

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
	onSwitchBackend(backendId: string): Promise<unknown>;
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
	onSwitchBackend,
	onDeletePersona,
	onPickWorkspace,
	onRevealWorkspace,
	onRefreshBackends,
}: Props) {
	const [sectionRailOpen, setSectionRailOpen] = useState(false);
	const [railScrolled, setRailScrolled] = useState(false);
	const [paneScrolled, setPaneScrolled] = useState(false);
	const scrolled = railScrolled || paneScrolled;

	/* Widening puts the rail back in the layout. Keeping its drawer state would
	 * make it spring open again if the window crossed the threshold twice. */
	useEffect(() => {
		if (!narrow) setSectionRailOpen(false);
	}, [narrow]);

	useEffect(() => {
		if (route.scope === "teammate" && persona === null) onClose();
	}, [route.scope, persona, onClose]);

	if (route.scope === "teammate" && persona === null) return null;

	const scopeName = route.scope === "teammate" && persona ? persona.name : "Toad";
	const showSectionRail = !narrow || sectionRailOpen;
	const select = (section: string) => {
		const known =
			route.scope === "teammate"
				? TEAMMATE_SECTIONS.some((entry) => entry.id === section)
				: APP_SECTIONS.some((entry) => entry.id === section);
		if (!known) return;
		onRoute(
			// Picking from the rail leaves any drilled-in pane, which is what
			// choosing a destination means.
			route.scope === "teammate"
				? { scope: "teammate", section: section as TeammateSectionId }
				: { scope: "app", section: section as AppSectionId },
		);
		if (narrow) setSectionRailOpen(false);
	};

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
					className={`gap-xs pr-2xs ${narrow && insetLights() ? "pl-lights" : "pl-gutter"}`}
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
						{route.scope === "app" ? (
							<AppPane
								section={route.section}
								detail={route.detail}
								backends={backends}
								onRefreshBackends={onRefreshBackends}
								onOpenDetail={(detail: AppDetailId) =>
									onRoute({ scope: "app", section: route.section, detail })
								}
								onCloseDetail={() => onRoute({ scope: "app", section: route.section })}
							/>
						) : (
							persona && (
								<TeammatePane
									section={route.section}
									detail={route.detail}
									persona={persona}
									backends={backends}
									info={info}
									renameNonce={renameNonce}
									identityDraft={identityDraft}
									onIdentityDraftChange={onIdentityDraftChange}
									onPatch={onPatchPersona}
									onSwitchBackend={onSwitchBackend}
									onDelete={onDeletePersona}
									onPickWorkspace={onPickWorkspace}
									onRevealWorkspace={onRevealWorkspace}
									onOpenDetail={(detail: TeammateDetailId) =>
										onRoute({ scope: "teammate", section: route.section, detail })
									}
									onCloseDetail={() => onRoute({ scope: "teammate", section: route.section })}
								/>
							)
						)}
					</div>
				</div>
			</section>
		</div>
	);
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
