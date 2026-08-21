export type TeammateSectionId =
	| "identity"
	| "agent"
	| "tools"
	| "schedule"
	| "workspace"
	| "session"
	| "danger";
export type AppSectionId = "general" | "backends" | "mcp" | "storage" | "about";

/**
 * A pane opened from inside a section rather than from the rail.
 *
 * Configuring the built-in agent is not a sibling of the agent list — it is
 * what you get by drilling into the entry at the top of it. Two rail rows for
 * one thing is the shape that made the earlier version confusing, so this is
 * held on the route instead: the rail keeps showing Agents as the place you
 * are, and the pane shows how far in you have gone.
 */
export type AppDetailId = "toad-agent";

/**
 * Same idea for a teammate: editing a subagent is not a second Agent section,
 * and it is not a form swapped in under the list. The rail stays on Agent;
 * the pane is the editor.
 */
export type TeammateDetailId = "subagent-new" | `subagent:${string}`;

export type SettingsRoute =
	| { scope: "teammate"; section: TeammateSectionId; detail?: TeammateDetailId }
	| { scope: "app"; section: AppSectionId; detail?: AppDetailId };

export function subagentDetail(kind: string): TeammateDetailId {
	return `subagent:${kind}`;
}

export function isSubagentDetail(detail: TeammateDetailId | undefined): detail is TeammateDetailId {
	return detail === "subagent-new" || (typeof detail === "string" && detail.startsWith("subagent:"));
}

export function kindOfSubagentDetail(detail: TeammateDetailId): string | undefined {
	return detail === "subagent-new" ? undefined : detail.slice("subagent:".length);
}

export type SectionEntry<Id extends string> = { id: Id; title: string };

export const TEAMMATE_SECTIONS: ReadonlyArray<SectionEntry<TeammateSectionId>> = [
	{ id: "identity", title: "Identity" },
	{ id: "agent", title: "Agent" },
	{ id: "tools", title: "Tools" },
	{ id: "schedule", title: "Schedule" },
	{ id: "workspace", title: "Workspace" },
	{ id: "session", title: "Session" },
	{ id: "danger", title: "Danger" },
];

export const APP_SECTIONS: ReadonlyArray<SectionEntry<AppSectionId>> = [
	{ id: "general", title: "General" },
	{ id: "backends", title: "Agents" },
	{ id: "mcp", title: "MCP servers" },
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
	if (route.scope === "app" && route.detail === "toad-agent") return "Toad Agent";
	if (route.scope === "teammate" && route.detail === "subagent-new") return "New subagent";
	if (route.scope === "teammate" && route.detail?.startsWith("subagent:")) return "Subagent";
	const sections = route.scope === "teammate" ? TEAMMATE_SECTIONS : APP_SECTIONS;
	return sections.find((section) => section.id === route.section)?.title ?? route.section;
}
