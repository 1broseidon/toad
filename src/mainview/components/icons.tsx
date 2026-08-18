import type { ReactNode } from "react";

/**
 * The icon set, drawn here rather than pulled from a library so the stroke
 * matches the hairlines the rest of the app is built from: a 16px box, 1.5px
 * stroke, round caps and joins, and no fills. Anything that needs more
 * explanation than a glyph at that size gets a word instead. There is no play
 * glyph, because nothing in the UI starts a session by hand.
 */
function Icon({ children, className }: { children: ReactNode; className?: string }) {
	return (
		<svg
			width="16"
			height="16"
			viewBox="0 0 16 16"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.5"
			strokeLinecap="round"
			strokeLinejoin="round"
			className={className}
			aria-hidden="true"
		>
			{children}
		</svg>
	);
}

export const PlusIcon = ({ className }: { className?: string }) => (
	<Icon className={className}>
		<path d="M8 3.25v9.5M3.25 8h9.5" />
	</Icon>
);

export const CloseIcon = ({ className }: { className?: string }) => (
	<Icon className={className}>
		<path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />
	</Icon>
);

/* A paperclip at 16px is a caricature of one: the wire is drawn as a single
 * open hairpin, because the real double bend closes up into a smudge. */
export const ClipIcon = ({ className }: { className?: string }) => (
	<Icon className={className}>
		<path d="M11.5 7.25l-4 4a2.25 2.25 0 0 1-3.18-3.18l5-5a1.5 1.5 0 0 1 2.12 2.12l-5 5" />
	</Icon>
);

export const StopIcon = ({ className }: { className?: string }) => (
	<Icon className={className}>
		<rect x="4.25" y="4.25" width="7.5" height="7.5" rx="1.5" />
	</Icon>
);

/* Sliders rather than a gear: this button opens an inspector, and a gear at
 * 16px is mush anyway. The rails break around each knob so the stroke reads. */
export const SlidersIcon = ({ className }: { className?: string }) => (
	<Icon className={className}>
		<path d="M2.5 5.5h1.75M7.75 5.5h5.75" />
		<circle cx="6" cy="5.5" r="1.75" />
		<path d="M2.5 10.5h5.75M11.75 10.5h1.75" />
		<circle cx="10" cy="10.5" r="1.75" />
	</Icon>
);

export const SendIcon = ({ className }: { className?: string }) => (
	<Icon className={className}>
		<path d="M8 12.75V3.75M4.25 7.5L8 3.75l3.75 3.75" />
	</Icon>
);

/* Out of a screen and back to what it was laid over. The same arrow as Send,
 * turned: there are two directional glyphs in the set and drawing them
 * differently would make a direction look like a different kind of thing. */
export const BackIcon = ({ className }: { className?: string }) => (
	<Icon className={className}>
		<path d="M12.25 8H3.25M7 4.25L3.25 8l3.75 3.75" />
	</Icon>
);

/* The roster, brought back after the window got too narrow to hold it: a pane
 * edge with the rows still in it, rather than a hamburger. This app has one
 * sidebar and it has a shape, so the button can just be that shape. */
export const RosterIcon = ({ className }: { className?: string }) => (
	<Icon className={className}>
		<rect x="2.25" y="3.25" width="11.5" height="9.5" rx="1.5" />
		<path d="M6.25 3.25v9.5" />
	</Icon>
);

/* The one glyph off the 16px grid. It trails a word rather than standing on its
 * own, so it is drawn at 10px to sit inside the cap height instead of towering
 * over the label it belongs to. */
export const CaretIcon = ({ className }: { className?: string }) => (
	<svg
		width="10"
		height="10"
		viewBox="0 0 10 10"
		fill="none"
		stroke="currentColor"
		strokeWidth="1.5"
		strokeLinecap="round"
		strokeLinejoin="round"
		className={className}
		aria-hidden="true"
	>
		<path d="M2.25 4l2.75 2.75L7.75 4" />
	</svg>
);

/* A gear for the app's own settings, kept apart from the sliders that open a
 * teammate's.
 *
 * The body is drawn as a ring with six teeth standing off it, because teeth
 * alone — spokes radiating from a dot — read as a snowflake at this size. Six is
 * the most that fits: eight closes the gaps up and the ring becomes a circle.
 */
export const CogIcon = ({ className }: { className?: string }) => (
	<Icon className={className}>
		<circle cx="8" cy="8" r="1.4" />
		<circle cx="8" cy="8" r="4.4" />
		<path d="M12.4 8h2M10.2 11.81l1 1.73M5.8 11.81l-1 1.73M3.6 8h-2M5.8 4.19l-1-1.73M10.2 4.19l1-1.73" />
	</Icon>
);

export const RevealIcon = ({ className }: { className?: string }) => (
	<Icon className={className}>
		<path d="M9.75 3.25h3v3M12.75 3.25L7.5 8.5" />
		<path d="M11 9.75v1.75a1.25 1.25 0 0 1-1.25 1.25h-6a1.25 1.25 0 0 1-1.25-1.25v-6A1.25 1.25 0 0 1 3.75 4.25H5.5" />
	</Icon>
);
