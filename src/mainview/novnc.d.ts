/**
 * The slice of noVNC's RFB client Toad uses. The package ships no types;
 * this declares only what the computer pane touches.
 */
declare module "@novnc/novnc" {
	export default class RFB extends EventTarget {
		constructor(
			target: HTMLElement,
			url: string,
			options?: { credentials?: { username?: string; password?: string; target?: string } },
		);
		scaleViewport: boolean;
		resizeSession: boolean;
		viewOnly: boolean;
		background: string;
		disconnect(): void;
	}
}
