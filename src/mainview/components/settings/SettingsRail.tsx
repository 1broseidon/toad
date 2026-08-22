import { webClient } from "../../platform";
import { RailShell } from "../RailShell";
import { BackIcon } from "../icons";
import {
	APP_SECTIONS,
	TEAMMATE_SECTIONS,
	type SettingsRoute,
} from "./sections";

type Props = {
	route: SettingsRoute;
	/** The teammate's name, or "Toad". Heads the section list. */
	scopeName: string;
	drawer: boolean;
	scrolled: boolean;
	hasSelected: boolean;
	onScrollEdge(scrolled: boolean): void;
	onSelect(section: string): void;
	onBack(): void;
};

export function SettingsRail({
	route,
	scopeName,
	drawer,
	scrolled,
	hasSelected,
	onScrollEdge,
	onSelect,
	onBack,
}: Props) {
	const sections = route.scope === "teammate" ? TEAMMATE_SECTIONS : APP_SECTIONS;

	return (
		<RailShell
			drawer={drawer}
			scrolled={scrolled}
			// As a drawer this rail is laid over the pane, and the lights are
			// inlaid over the pane's own band rather than over this one.
			underLights={!drawer}
			navLabel="Settings"
			onScrollEdge={onScrollEdge}
			footer={
				<>
					{/* Out of settings, back to the conversation. First, because it is
					    the way out and the way out belongs where the hand already is. */}
					<button type="button" className="rail-action" title="Back (Esc)" onClick={onBack}>
						<BackIcon />
						<span>{hasSelected ? "Back to chat" : "Back"}</span>
					</button>

					{/* Which set of settings you are in. The phone says it in the band
					    at the top of the pane already, and a caption under the way out
					    is one more thing between the thumb and the edge. */}
					{!webClient() && (
						<p className="flex items-center gap-xs px-xs pb-3xs pt-2xs text-2xs text-ink-3">
							{route.scope === "teammate" ? "teammate settings" : "app settings"}
						</p>
					)}
				</>
			}
		>
			<p className="label px-xs pt-2xs">{scopeName}</p>
			{sections.map((section) => (
				<button
					key={section.id}
					type="button"
					aria-current={section.id === route.section ? "page" : undefined}
					className={`nav-row ${section.id === route.section ? "nav-row-on" : ""}`}
					onClick={() => onSelect(section.id)}
				>
					{section.title}
				</button>
			))}
		</RailShell>
	);
}
