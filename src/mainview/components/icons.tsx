import {
	ArrowDown,
	ArrowLeft,
	ArrowUp,
	ChevronDown,
	Copy,
	Ellipsis,
	Info,
	Maximize,
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

export const CloseIcon = ({ className }: IconProps) => <X className={className} {...line} />;

export const MenuIcon = ({ className }: IconProps) => <Menu className={className} {...line} />;

export const MinimizeIcon = ({ className }: IconProps) => (
	<Minus className={className} {...line} />
);

export const MaximizeIcon = ({ className }: IconProps) => (
	<Maximize className={className} {...line} />
);

export const RestoreIcon = ({ className }: IconProps) => <Copy className={className} {...line} />;

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
