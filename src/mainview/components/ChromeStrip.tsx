import { useEffect, useRef, useState } from "react";
import type { PopupItem } from "./PopupMenu";
import { PopupMenu } from "./PopupMenu";
import { DRAG, NO_DRAG } from "./Toolbar";
import { ToadMark } from "./ToadMark";
import {
	CloseIcon,
	MaximizeIcon,
	MenuIcon,
	MinimizeIcon,
	RestoreIcon,
} from "./icons";

type Props = {
	title: string;
	maximized: boolean;
	/** Null on Windows, whose native application menu remains enabled. */
	items: PopupItem[] | null;
	onMinimize(): void;
	onMaximizeToggle(): void;
	onClose(): void;
};

/**
 * Frameless desktop chrome: mark, quiet title, min/max/close — plus the HTML
 * menu on Linux, where Electrobun's native application menu is a no-op.
 *
 * Mounted above the app's relative shell so settings and new-teammate overlays
 * cannot cover the caption buttons. Drag uses the same Electrobun marker
 * classes as the toolbar — packaged builds cannot fetch views:// CSS.
 */
export function ChromeStrip({
	title,
	maximized,
	items,
	onMinimize,
	onMaximizeToggle,
	onClose,
}: Props) {
	const [focused, setFocused] = useState(() => document.hasFocus());
	const [menu, setMenu] = useState(false);
	const bar = useRef<HTMLElement>(null);

	useEffect(() => {
		const on = () => setFocused(true);
		const off = () => setFocused(false);
		window.addEventListener("focus", on);
		window.addEventListener("blur", off);
		return () => {
			window.removeEventListener("focus", on);
			window.removeEventListener("blur", off);
		};
	}, []);

	return (
		<div className="relative shrink-0">
			<header
				ref={bar}
				className={`chrome ${DRAG}`}
				data-blur={!focused}
				onDoubleClick={(event) => {
					if ((event.target as HTMLElement).closest("button")) return;
					onMaximizeToggle();
				}}
			>
				{items && (
					<button
						type="button"
						className={`chrome-menu ${NO_DRAG}`}
						aria-label="Menu"
						aria-haspopup="menu"
						aria-expanded={menu}
						onPointerDown={(event) => event.stopPropagation()}
						onClick={() => setMenu((open) => !open)}
					>
						<MenuIcon />
					</button>
				)}
				{/* Decorative: where the hamburger exists it is the target, and two
				    things to press that close together is a Fitts trap. */}
				<ToadMark className="chrome-mark" />
				<span className="chrome-title" aria-hidden="true">
					{title}
				</span>
				<div className="chrome-caps">
					<button
						type="button"
						className={`chrome-cap ${NO_DRAG}`}
						aria-label="Minimize"
						onClick={onMinimize}
					>
						<MinimizeIcon />
					</button>
					<button
						type="button"
						className={`chrome-cap ${NO_DRAG}`}
						aria-label={maximized ? "Restore" : "Maximize"}
						onClick={onMaximizeToggle}
					>
						{maximized ? <RestoreIcon /> : <MaximizeIcon />}
					</button>
					<button
						type="button"
						className={`chrome-cap chrome-cap-close ${NO_DRAG}`}
						aria-label="Close"
						onClick={onClose}
					>
						<CloseIcon />
					</button>
				</div>
			</header>
			{menu && items && (
				<PopupMenu
					x={8}
					y={(bar.current?.getBoundingClientRect().bottom ?? 32) + 4}
					items={items}
					onClose={() => setMenu(false)}
				/>
			)}
		</div>
	);
}