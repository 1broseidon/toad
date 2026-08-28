import { type PointerEvent, useRef } from "react";
import { MIN_WINDOW, type WindowFrame } from "../../shared/rpc";
import { api } from "../rpc";
import { NO_DRAG } from "./Toolbar";

type Edge = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

const GRIPS: Edge[] = ["n", "s", "e", "w", "ne", "nw", "se", "sw"];

/**
 * Frameless Linux/Windows resize. `titleBarStyle: "hidden"` drops native
 * decorations, and Electrobun exposes no begin-resize drag, so the page owns
 * the edges.
 *
 * Windows has nothing to fall back to if they are missing: `"hidden"` is a
 * bare `WS_POPUP` there, with no `WS_THICKFRAME` and no border case in
 * `WM_NCHITTEST` (package/src/native/win/nativeWrapper.cpp), so these grips
 * are the only resize that window has. They must therefore actually be
 * mounted — see `windowIsFullScreen` in src/bun/index.ts for why they were not.
 *
 * Screen coordinates, not client: a west/north drag moves the window origin,
 * and a clientX delta would count that move twice.
 */
export function ResizeHandles() {
	const drag = useRef<{
		edge: Edge;
		start: WindowFrame;
		sx: number;
		sy: number;
		cursor: string;
	} | null>(null);
	const pending = useRef<WindowFrame | null>(null);
	const flying = useRef(false);

	const push = (frame: WindowFrame) => {
		pending.current = frame;
		if (flying.current) return;
		flying.current = true;
		void (async () => {
			while (pending.current) {
				const next = pending.current;
				pending.current = null;
				await api.windowSetFrame(next);
			}
			flying.current = false;
		})();
	};

	const onDown = (edge: Edge) => (event: PointerEvent<HTMLDivElement>) => {
		if (event.button !== 0) return;
		event.preventDefault();
		event.stopPropagation();
		const grip = event.currentTarget;
		grip.setPointerCapture(event.pointerId);
		const cursor = getComputedStyle(grip).cursor;
		document.body.style.cursor = cursor;
		void api.windowGetFrame().then((start) => {
			if (!grip.hasPointerCapture(event.pointerId)) return;
			drag.current = { edge, start, sx: event.screenX, sy: event.screenY, cursor };
		});
	};

	const onMove = (event: PointerEvent<HTMLDivElement>) => {
		const live = drag.current;
		if (!live) return;
		push(
			applyEdge(
				live.edge,
				live.start,
				event.screenX - live.sx,
				event.screenY - live.sy,
			),
		);
	};

	const onUp = (event: PointerEvent<HTMLDivElement>) => {
		if (drag.current) {
			drag.current = null;
			document.body.style.cursor = "";
		}
		if (event.currentTarget.hasPointerCapture(event.pointerId)) {
			event.currentTarget.releasePointerCapture(event.pointerId);
		}
	};

	return (
		<div className="resize-layer" aria-hidden="true">
			{GRIPS.map((edge) => (
				<div
					key={edge}
					data-edge={edge}
					className={`resize-grip ${NO_DRAG}`}
					onPointerDown={onDown(edge)}
					onPointerMove={onMove}
					onPointerUp={onUp}
					onPointerCancel={onUp}
				/>
			))}
		</div>
	);
}

function applyEdge(edge: Edge, start: WindowFrame, dx: number, dy: number): WindowFrame {
	let { x, y, width, height } = start;
	if (edge.includes("e")) width = Math.max(MIN_WINDOW.width, start.width + dx);
	if (edge.includes("s")) height = Math.max(MIN_WINDOW.height, start.height + dy);
	if (edge.includes("w")) {
		width = Math.max(MIN_WINDOW.width, start.width - dx);
		x = start.x + start.width - width;
	}
	if (edge.includes("n")) {
		height = Math.max(MIN_WINDOW.height, start.height - dy);
		y = start.y + start.height - height;
	}
	return { x, y, width, height };
}
