import type { ReactNode } from "react";
import { insetLights, linuxChrome } from "../platform";
import { ToadMark } from "./ToadMark";
import { Toolbar } from "./Toolbar";

/**
 * The left rail, whatever is currently listed in it.
 *
 * The roster and the settings sections are the same object seen twice — a mark
 * over a scrolling list over a bordered footer, 236px wide, lifting into a
 * drawer when the window cannot hold it beside the pane. Only the list and the
 * footer's contents differ, so only those are passed in.
 *
 * Linux is the exception: the chrome strip already carries the mark, so the
 * stamp comes off and the list starts at the top of the rail.
 */

type Props = {
	/** Lifted over the pane rather than beside it, once the window is narrow. */
	drawer: boolean;
	scrolled: boolean;
	/**
	 * Whether the band starts clear of the window's traffic lights. The two
	 * rails answer this differently as drawers, which is why it is asked.
	 */
	underLights: boolean;
	navLabel: string;
	onScrollEdge(scrolled: boolean): void;
	/** A card that belongs to neither the list nor the footer, between them. */
	beforeFooter?: ReactNode;
	footer: ReactNode;
	children: ReactNode;
};

export function RailShell({
	drawer,
	scrolled,
	underLights,
	navLabel,
	onScrollEdge,
	beforeFooter,
	footer,
	children,
}: Props) {
	return (
		<aside
			/* No border down the inside edge: the pane's corners curve away from it,
			   and a straight rule against a curve reads as a mistake. The step in
			   tone is the seam. */
			className={`flex h-full w-[236px] shrink-0 flex-col bg-paper-2 lg:w-[272px] ${
				/* As a drawer it is lifted off the pane rather than beside it, so it
				   needs the shadow to say which one is on top. */
				drawer ? "absolute inset-y-0 left-0 z-overlay animate-slide-in shadow-float" : ""
			}`}
		>
			{/* The window has no titlebar, so this band drags it. Where the traffic
			    lights are inlaid over it, the mark sits just past them on their
			    centre line — the only line in the window that cannot move. Linux's
			    chrome strip carries the same mark, so here the band would be a
			    second one and the list takes it instead. */}
			{!linuxChrome() && (
				<Toolbar className={underLights && insetLights() ? "pl-lights" : "pl-md"} scrolled={scrolled}>
					<h1 className="flex items-center">
						<ToadMark className="rail-mark" label="Toad" />
					</h1>
				</Toolbar>
			)}

			<nav
				aria-label={navLabel}
				className="flex-1 overflow-y-auto px-2xs pb-xs pt-2xs"
				onScroll={(event) => onScrollEdge(event.currentTarget.scrollTop > 0)}
			>
				{children}
			</nav>

			{beforeFooter}

			<footer className="border-t border-rule-2 px-2xs pb-lg pt-2xs">{footer}</footer>
		</aside>
	);
}
