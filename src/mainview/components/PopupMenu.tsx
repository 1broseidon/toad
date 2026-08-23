import { type KeyboardEvent, useEffect, useLayoutEffect, useRef, useState } from "react";
import { webClient } from "../platform";
import { CaretIcon } from "./icons";

export type PopupItem =
	| { type: "divider" }
	| {
			label: string;
			danger?: boolean;
			enabled?: boolean;
			accelerator?: string;
			checked?: boolean;
			onClick(): void;
	  }
	| { label: string; items: PopupItem[]; enabled?: boolean };

function isDivider(item: PopupItem): item is { type: "divider" } {
	return "type" in item && item.type === "divider";
}

function isBranch(item: PopupItem): item is { label: string; items: PopupItem[]; enabled?: boolean } {
	return "items" in item;
}

function isEnabled(item: PopupItem): boolean {
	if (isDivider(item)) return false;
	return item.enabled !== false;
}

function firstEnabled(items: PopupItem[]): number {
	return items.findIndex(isEnabled);
}

function nextEnabled(items: PopupItem[], from: number, dir: 1 | -1): number {
	const len = items.length;
	if (len === 0) return from;
	let i = from;
	for (let n = 0; n < len; n++) {
		i = (i + dir + len) % len;
		if (isEnabled(items[i]!)) return i;
	}
	return from;
}

const PAD = 8;
const HOVER_MS = 130;

type Props = {
	x: number;
	y: number;
	items: PopupItem[];
	onClose(): void;
};

/**
 * A menu drawn in the page.
 *
 * Linux has no native one: Electrobun's GTK wrapper logs and does nothing, so
 * the same items the Mac menu would have shown land here instead. Branches
 * fly out on hover, using the same skin at every depth.
 */
export function PopupMenu({ x, y, items, onClose }: Props) {
	return <MenuPanel items={items} x={x} y={y} onClose={onClose} onDismiss={onClose} />;
}

type PanelProps = {
	items: PopupItem[];
	x: number;
	y: number;
	onClose(): void;
	onDismiss(): void;
	nested?: boolean;
};

function rowAt(root: HTMLDivElement | null, index: number): HTMLButtonElement | null {
	return root?.querySelector(`[data-index="${index}"]`) ?? null;
}

function MenuPanel({ items, x, y, onClose, onDismiss, nested }: PanelProps) {
	const root = useRef<HTMLDivElement>(null);
	const [open, setOpen] = useState<{ index: number; x: number; y: number } | null>(null);
	const [focus, setFocus] = useState(() => firstEnabled(items));
	const hoverTimer = useRef<number | null>(null);
	const openRef = useRef(open);
	openRef.current = open;

	useLayoutEffect(() => {
		const el = root.current;
		if (!el) return;
		/* On the phone the stylesheet pins the menu to the foot as a sheet;
		 * a corner anchored to a finger means nothing there. */
		if (webClient() && !nested) return;
		const rect = el.getBoundingClientRect();
		let left = x;
		let top = y;
		if (nested) {
			if (x + rect.width > window.innerWidth - PAD) left = x - rect.width + 8;
		} else {
			left = Math.min(x, window.innerWidth - rect.width - PAD);
		}
		top = Math.min(Math.max(PAD, top), window.innerHeight - rect.height - PAD);
		left = Math.max(PAD, left);
		el.style.left = `${left}px`;
		el.style.top = `${top}px`;
	}, [x, y, nested]);

	useEffect(() => {
		return () => {
			if (hoverTimer.current) window.clearTimeout(hoverTimer.current);
		};
	}, []);

	useEffect(() => {
		if (nested) return;
		const onPointer = (event: PointerEvent) => {
			if (!root.current?.contains(event.target as Node)) onClose();
		};
		document.addEventListener("pointerdown", onPointer);
		return () => document.removeEventListener("pointerdown", onPointer);
	}, [nested, onClose]);

	useEffect(() => {
		rowAt(root.current, focus)?.focus();
	}, [focus]);

	const clearHover = () => {
		if (hoverTimer.current) window.clearTimeout(hoverTimer.current);
		hoverTimer.current = null;
	};

	const openBranch = (index: number, row: HTMLElement) => {
		const item = items[index];
		if (!item || isDivider(item) || !isBranch(item) || item.enabled === false) {
			setOpen(null);
			return;
		}
		const rect = row.getBoundingClientRect();
		setOpen({ index, x: rect.right - 4, y: rect.top });
	};

	const scheduleOpen = (index: number, row: HTMLElement) => {
		clearHover();
		hoverTimer.current = window.setTimeout(() => openBranch(index, row), HOVER_MS);
	};

	const activate = (index: number, row: HTMLElement) => {
		const item = items[index];
		if (!item || isDivider(item) || !isEnabled(item)) return;
		if (isBranch(item)) {
			clearHover();
			openBranch(index, row);
			return;
		}
		onClose();
		item.onClick();
	};

	const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		if (openRef.current && event.key !== "Escape" && event.key !== "ArrowLeft") return;
		const key = event.key;
		if (key === "Escape") {
			event.preventDefault();
			event.stopPropagation();
			onClose();
			return;
		}
		if (key === "ArrowLeft" && nested) {
			event.preventDefault();
			event.stopPropagation();
			onDismiss();
			return;
		}
		if (key === "ArrowDown") {
			event.preventDefault();
			setFocus((i) => nextEnabled(items, i, 1));
			return;
		}
		if (key === "ArrowUp") {
			event.preventDefault();
			setFocus((i) => nextEnabled(items, i, -1));
			return;
		}
		if (key === "Home") {
			event.preventDefault();
			setFocus(firstEnabled(items));
			return;
		}
		if (key === "End") {
			event.preventDefault();
			setFocus(nextEnabled(items, 0, -1));
			return;
		}
		if (key === "ArrowRight" || key === "Enter" || key === " ") {
			const row = rowAt(root.current, focus);
			if (!row) return;
			event.preventDefault();
			activate(focus, row);
			return;
		}
		if (key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
			const letter = key.toLowerCase();
			const start = focus + 1;
			for (let n = 0; n < items.length; n++) {
				const i = (start + n) % items.length;
				const item = items[i]!;
				if (isDivider(item) || !isEnabled(item)) continue;
				if (item.label.toLowerCase().startsWith(letter)) {
					event.preventDefault();
					setFocus(i);
					return;
				}
			}
		}
	};

	const branch = open && isBranch(items[open.index]!) ? items[open.index] : null;

	return (
		<div
			ref={root}
			role="menu"
			className="popup-menu"
			/* The phone's sheet is placed by the stylesheet, not the finger. */
			style={webClient() && !nested ? undefined : { left: x, top: y }}
			onKeyDown={onKeyDown}
			onMouseLeave={nested ? undefined : () => {
				clearHover();
				hoverTimer.current = window.setTimeout(() => setOpen(null), HOVER_MS);
			}}
		>
			{items.map((item, index) => {
				if (isDivider(item)) {
					return <div key={`div-${index}`} className="popup-menu-rule" />;
				}
				const disabled = item.enabled === false;
				if (isBranch(item)) {
					return (
						<button
							key={item.label}
							type="button"
							role="menuitem"
							aria-haspopup="menu"
							aria-expanded={open?.index === index}
							disabled={disabled}
							tabIndex={focus === index ? 0 : -1}
							data-index={index}
							data-open={open?.index === index}
							className="popup-menu-row"
							onMouseEnter={(event) => {
								setFocus(index);
								if (!disabled) scheduleOpen(index, event.currentTarget);
							}}
							onClick={(event) => {
								if (!disabled) activate(index, event.currentTarget);
							}}
						>
							<span className="min-w-0 flex-1 truncate text-left">{item.label}</span>
							<CaretIcon className="popup-menu-caret" />
						</button>
					);
				}
				return (
					<button
						key={item.label}
						type="button"
						role="menuitem"
						aria-checked={item.checked}
						disabled={disabled}
						tabIndex={focus === index ? 0 : -1}
						data-index={index}
						className={`popup-menu-row ${item.danger ? "text-danger" : ""} ${item.checked ? "font-medium" : ""}`}
						onMouseEnter={() => {
							setFocus(index);
							clearHover();
							setOpen(null);
						}}
						onClick={() => {
							if (disabled) return;
							onClose();
							item.onClick();
						}}
					>
						<span className="min-w-0 flex-1 truncate text-left">{item.label}</span>
						{item.accelerator && <span className="popup-menu-accel">{item.accelerator}</span>}
					</button>
				);
			})}
			{branch && isBranch(branch) && (
				<MenuPanel
					items={branch.items}
					x={open!.x}
					y={open!.y}
					onClose={onClose}
					onDismiss={() => setOpen(null)}
					nested
				/>
			)}
		</div>
	);
}
