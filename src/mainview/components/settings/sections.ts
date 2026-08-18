export type TeammateSectionId = "identity" | "agent" | "workspace" | "session" | "danger";
export type AppSectionId = "general" | "backends" | "storage" | "about";

export type SettingsRoute =
	| { scope: "teammate"; section: TeammateSectionId }
	| { scope: "app"; section: AppSectionId };

export type SectionEntry<Id extends string> = { id: Id; title: string };

export const TEAMMATE_SECTIONS: ReadonlyArray<SectionEntry<TeammateSectionId>> = [
	{ id: "identity", title: "Identity" },
	{ id: "agent", title: "Agent" },
	{ id: "workspace", title: "Workspace" },
	{ id: "session", title: "Session" },
	{ id: "danger", title: "Danger" },
];

export const APP_SECTIONS: ReadonlyArray<SectionEntry<AppSectionId>> = [
	{ id: "general", title: "General" },
	{ id: "backends", title: "Backends" },
	{ id: "storage", title: "Storage" },
	{ id: "about", title: "About" },
];

export const DEFAULT_TEAMMATE_SECTION: TeammateSectionId = "identity";
export const DEFAULT_APP_SECTION: AppSectionId = "general";

/** Whether an id still names a section in that scope, for a remembered route. */
export function isTeammateSection(id: string): id is TeammateSectionId {
	return TEAMMATE_SECTIONS.some((section) => section.id === id);
}

export function isAppSection(id: string): id is AppSectionId {
	return APP_SECTIONS.some((section) => section.id === id);
}

/** The section's own name, for the pane header. */
export function titleOf(route: SettingsRoute): string {
	const sections = route.scope === "teammate" ? TEAMMATE_SECTIONS : APP_SECTIONS;
	return sections.find((section) => section.id === route.section)?.title ?? route.section;
}
