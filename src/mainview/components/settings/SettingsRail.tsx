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
	onScrollEdge(scrolled: boolean): void;
	onSelect(section: string): void;
	onBack(): void;
};

export function SettingsRail({
	route,
	scopeName,
	drawer,
	scrolled,
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
				/* The way out sits in the exact slot the Settings button occupies
				   in the roster rail — going in and coming out are the same place
				   under the hand, and nothing else shares the slot. */
				<button type="button" className="rail-action" title="Back (Esc)" onClick={onBack}>
					<BackIcon />
					<span>Back</span>
				</button>
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
