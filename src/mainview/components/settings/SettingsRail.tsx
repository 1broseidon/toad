import { Toolbar } from "../Toolbar";
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
		<aside
			/* No border down the inside edge, for the same reason as the roster:
			   the pane's corners curve away from it, and a straight rule against a
			   curve reads as a mistake. The step in tone is the seam. */
			className={`flex h-full w-[236px] shrink-0 flex-col bg-paper-2 lg:w-[272px] ${
				drawer ? "absolute inset-y-0 left-0 z-overlay animate-slide-in shadow-float" : ""
			}`}
		>
			<Toolbar className={drawer ? "pl-md" : "pl-lights"} scrolled={scrolled}>
				<h1 className="wordmark">toad</h1>
			</Toolbar>

			<nav
				aria-label="Settings sections"
				className="flex-1 overflow-y-auto px-2xs pb-xs pt-2xs"
				onScroll={(event) => onScrollEdge(event.currentTarget.scrollTop > 0)}
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
			</nav>

			<footer className="border-t border-rule-2 px-2xs py-2xs">
				{/* Out of settings, back to the conversation. First, because it is
				    the way out and the way out belongs where the hand already is. */}
				<button type="button" className="rail-action" title="Back (Esc)" onClick={onBack}>
					<BackIcon />
					<span>{hasSelected ? "back to chat" : "back"}</span>
				</button>

				<p className="flex items-center gap-xs px-xs pb-3xs pt-2xs text-2xs text-ink-3">
					{route.scope === "teammate" ? "teammate settings" : "app settings"}
				</p>
			</footer>
		</aside>
	);
}
