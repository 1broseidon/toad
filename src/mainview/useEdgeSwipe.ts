import { useEffect, useRef, type RefObject } from "react";

/**
 * The platform's back gesture, for the one screen that stacks over another.
 *
 * A drag that starts on the left edge and moves right pulls the pane with
 * the finger, then either commits — the pane slides off and `onBack`
 * fires — or snaps home. Vertical scrolling is left alone: the gesture
 * claims the touch only from the edge, and only once it is clearly
 * horizontal. Everything here writes inline styles and cleans them up, so
 * the stylesheet's own transitions stay the owners of the resting states.
 */
export function useEdgeSwipe(
	ref: RefObject<HTMLElement | null>,
	enabled: boolean,
	onBack: () => void,
) {
	/* The latest callback without re-arming the listeners: the pane re-renders
	 * on every transcript token, and a drag must survive that. */
	const back = useRef(onBack);
	back.current = onBack;

	useEffect(() => {
		const pane = ref.current;
		if (!enabled || !pane) return;

		/** How far from the left edge a back-drag may begin. */
		const EDGE = 28;
		let x0 = 0;
		let y0 = 0;
		let lastX = 0;
		let lastT = 0;
		let velocity = 0;
		let width = 1;
		let dragging = false;
		let claimed = false;

		const onStart = (event: TouchEvent) => {
			const touch = event.touches[0];
			if (!touch || event.touches.length > 1 || touch.clientX > EDGE) return;
			x0 = touch.clientX;
			y0 = touch.clientY;
			lastX = x0;
			lastT = event.timeStamp;
			velocity = 0;
			width = pane.clientWidth || 1;
			dragging = true;
			claimed = false;
		};

		const onMove = (event: TouchEvent) => {
			if (!dragging) return;
			const touch = event.touches[0];
			if (!touch) return;
			const dx = touch.clientX - x0;
			const dy = touch.clientY - y0;
			if (!claimed) {
				// A scroll is a scroll; only a clearly horizontal pull is a pop.
				if (Math.abs(dy) > Math.abs(dx)) {
					if (Math.abs(dy) > 12) dragging = false;
					return;
				}
				if (dx < 8) return;
				claimed = true;
				pane.style.transition = "none";
			}
			event.preventDefault();
			if (event.timeStamp > lastT) {
				velocity = (touch.clientX - lastX) / (event.timeStamp - lastT);
				lastX = touch.clientX;
				lastT = event.timeStamp;
			}
			pane.style.transform = `translateX(${Math.max(0, dx)}px)`;
		};

		const settle = (commit: boolean) => {
			pane.style.transition = "";
			if (!commit) {
				pane.style.transform = "";
				return;
			}
			// Finish the slide from wherever the finger left it, then hand the
			// resting state back to the stylesheet.
			let done = false;
			const finish = () => {
				if (done) return;
				done = true;
				pane.removeEventListener("transitionend", finish);
				pane.style.transform = "";
				pane.style.transition = "";
				back.current();
			};
			pane.addEventListener("transitionend", finish);
			// Reduced motion collapses the transition; the pop still happens.
			window.setTimeout(finish, 400);
			pane.style.transform = "translateX(100%)";
		};

		const onEnd = (event: TouchEvent) => {
			if (!dragging) return;
			dragging = false;
			if (!claimed) return;
			const dx = (event.changedTouches[0]?.clientX ?? x0) - x0;
			settle(dx > width * 0.35 || velocity > 0.5);
		};

		pane.addEventListener("touchstart", onStart, { passive: true });
		pane.addEventListener("touchmove", onMove, { passive: false });
		pane.addEventListener("touchend", onEnd);
		pane.addEventListener("touchcancel", onEnd);
		return () => {
			pane.removeEventListener("touchstart", onStart);
			pane.removeEventListener("touchmove", onMove);
			pane.removeEventListener("touchend", onEnd);
			pane.removeEventListener("touchcancel", onEnd);
		};
	}, [ref, enabled]);
}
