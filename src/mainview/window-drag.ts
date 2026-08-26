import { webClient } from "./platform";

/**
 * The other half of letting go.
 *
 * Electrobun's drag-region runtime starts a native window move on mousedown
 * in a drag region, but only stops it when the mouseup ALSO lands on a drag
 * region. Release over a control, over content, or anywhere the moving
 * window has shifted under the cursor, and the stop never sends — the
 * window stays glued to the mouse until the next clean click, sometimes
 * sailing off screen on the way. This listens in the capture phase, marks
 * when a drag really began, and stops the move on any release at all. A
 * stop with no move in flight is a no-op, so erring loud costs nothing.
 */

const DRAG = "electrobun-webkit-app-region-drag";
const NO_DRAG = "electrobun-webkit-app-region-no-drag";

type Bridge = { postMessage(message: string): void };

function startedInDragRegion(target: EventTarget | null): boolean {
	let element =
		target instanceof Element ? target : ((target as Node | null)?.parentElement ?? null);
	let found = false;
	while (element) {
		if (element.classList?.contains(NO_DRAG)) return false;
		if (element.classList?.contains(DRAG)) found = true;
		element = element.parentElement;
	}
	return found;
}

export function installDragRelease(): void {
	if (webClient()) return;
	const bridge = (window as { __electrobunInternalBridge?: Bridge }).__electrobunInternalBridge;
	if (!bridge) return;

	let moving = false;
	const stop = () => {
		if (!moving) return;
		moving = false;
		try {
			bridge.postMessage(
				JSON.stringify([
					JSON.stringify({
						type: "message",
						id: "stopWindowMove",
						payload: { id: (window as { __electrobunWindowId?: number }).__electrobunWindowId },
					}),
				]),
			);
		} catch {
			/* The runtime's own conditional stop remains; this was the backstop. */
		}
	};

	document.addEventListener(
		"mousedown",
		(event) => {
			if (event.button === 0 && startedInDragRegion(event.target)) moving = true;
		},
		true,
	);
	document.addEventListener("mouseup", stop, true);
	document.addEventListener("pointerup", stop, true);
	window.addEventListener("blur", stop);
}
