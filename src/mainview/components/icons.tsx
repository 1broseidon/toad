import {
	ArrowDown,
	ArrowLeft,
	ArrowUp,
	ChevronDown,
	Ellipsis,
	Info,
	Lock,
	LockOpen,
	Menu,
	MessagesSquare,
	Minus,
	Monitor,
	Paperclip,
	PanelLeft,
	Plus,
	Search,
	Settings,
	SlidersHorizontal,
	Square,
	SquareArrowOutUpRight,
	X,
	type LucideProps,
} from "lucide-react";

/**
 * The icon set, from Lucide rather than drawn here — one hand behind every
 * glyph beats twenty of ours. The wrappers keep each icon's name and its
 * `className`-only contract, so call sites never learn where glyphs come
 * from; and they pin the set to the app's line: a 16px box with a true
 * 1.5px stroke (`absoluteStrokeWidth`, or Lucide would scale it thinner).
 * Anything that needs more explanation than a glyph at that size gets a
 * word instead. There is no play glyph, because nothing in the UI starts a
 * session by hand.
 */

type IconProps = { className?: string };

const line: Partial<LucideProps> & { "aria-hidden": true } = {
	size: 16,
	strokeWidth: 1.5,
	absoluteStrokeWidth: true,
	"aria-hidden": true,
};

export const PlusIcon = ({ className }: IconProps) => <Plus className={className} {...line} />;

export const ComputerIcon = ({ className }: IconProps) => (
	<Monitor className={className} {...line} />
);

export const InfoIcon = ({ className }: IconProps) => <Info className={className} {...line} />;

/* A live wire's transport, on a peer row: closed rides TLS, open does not.
 * The word for whether the link is encrypted is the row's to say (sr-only /
 * title); the glyph alone would be a rumor. */
export const LockIcon = ({ className }: IconProps) => <Lock className={className} {...line} />;

export const UnlockedIcon = ({ className }: IconProps) => (
	<LockOpen className={className} {...line} />
);

export const CloseIcon = ({ className }: IconProps) => <X className={className} {...line} />;

export const MenuIcon = ({ className }: IconProps) => <Menu className={className} {...line} />;

export const MinimizeIcon = ({ className }: IconProps) => (
	<Minus className={className} {...line} />
);

/* A caption button, so the square every desktop puts there rather than
 * Lucide's `Maximize`, whose four corner arrows mean full screen — a
 * different item in our own Window menu. Shares a shape with StopIcon; they
 * never meet, and each is its surface's plainest word. */
export const MaximizeIcon = ({ className }: IconProps) => (
	<Square className={className} {...line} />
);

/* Drawn rather than picked: restore says the window steps back down, in
 * front of where it was, which is why every desktop offsets the two squares
 * down and to the left. Lucide's `Copy` is that pair mirrored, and mirrored
 * is the wrong direction for coming back. Same 16px box and true 1.5px
 * stroke as the set it sits in. */
export const RestoreIcon = ({ className }: IconProps) => (
	<svg
		className={className}
		width={16}
		height={16}
		viewBox="0 0 16 16"
		fill="none"
		stroke="currentColor"
		strokeWidth={1.5}
		strokeLinecap="round"
		strokeLinejoin="round"
		aria-hidden="true"
	>
		<path d="M5.25 5.25V4.5A1.5 1.5 0 0 1 6.75 3h4.75A1.5 1.5 0 0 1 13 4.5v4.75a1.5 1.5 0 0 1-1.5 1.5h-0.75" />
		<rect x="3" y="5.25" width="7.75" height="7.75" rx="1.5" />
	</svg>
);

export const ClipIcon = ({ className }: IconProps) => (
	<Paperclip className={className} {...line} />
);

export const StopIcon = ({ className }: IconProps) => <Square className={className} {...line} />;

/* Sliders rather than a gear: this button opens an inspector, and the gear
 * is spoken for by the app's own settings. */
export const SlidersIcon = ({ className }: IconProps) => (
	<SlidersHorizontal className={className} {...line} />
);

export const SendIcon = ({ className }: IconProps) => <ArrowUp className={className} {...line} />;

/* Out of a screen and back to what it was laid over. The same arrow as Send,
 * turned: two directions should not look like two different kinds of thing. */
export const BackIcon = ({ className }: IconProps) => (
	<ArrowLeft className={className} {...line} />
);

/* Send, pointed at the foot of the conversation. Same arrow, third heading. */
export const DownIcon = ({ className }: IconProps) => (
	<ArrowDown className={className} {...line} />
);

/* The roster, brought back after the window got too narrow to hold it: the
 * pane itself rather than a hamburger. This app has one sidebar and it has a
 * shape, so the button can just be that shape. */
export const RosterIcon = ({ className }: IconProps) => (
	<PanelLeft className={className} {...line} />
);

/* Peer threads: teammates talking to each other. */
export const ThreadsIcon = ({ className }: IconProps) => (
	<MessagesSquare className={className} {...line} />
);

export const SearchIcon = ({ className }: IconProps) => (
	<Search className={className} {...line} />
);

/* The one glyph off the 16px grid. It trails a word rather than standing on
 * its own, so it sits inside the cap height instead of towering over the
 * label it belongs to. */
export const CaretIcon = ({ className }: IconProps) => (
	<ChevronDown className={className} {...line} size={10} />
);

/* A gear for the app's own settings, kept apart from the sliders that open a
 * teammate's. */
export const CogIcon = ({ className }: IconProps) => (
	<Settings className={className} {...line} />
);

/* The rest of the row's actions, where there is no room to name them. */
export const MoreIcon = ({ className }: IconProps) => (
	<Ellipsis className={className} {...line} />
);

export const RevealIcon = ({ className }: IconProps) => (
	<SquareArrowOutUpRight className={className} {...line} />
);
