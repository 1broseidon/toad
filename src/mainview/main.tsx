import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

// Tokens load first so Tailwind's preflight never sits between the custom
// properties and the rules that consume them.
import "../../tokens.css";
import "./index.css";
import { installDragRelease } from "./window-drag";
import App from "./App";
import { applyPlatformClasses, nativeShell } from "./platform";

applyPlatformClasses();

if (nativeShell()) {
	void import("@capacitor/status-bar")
		.then(({ StatusBar, Style }) => StatusBar.setStyle({ style: Style.Dark }))
		.catch(() => {});
	/* WKWebView puts a form-navigation bar over the keyboard — prev/next arrows
	 * and a Done button, for stepping through the fields of a web form. There is
	 * one field here and Enter sends it, so the bar is a strip of borrowed
	 * chrome between the composer and the keys. */
	void import("@capacitor/keyboard")
		.then(({ Keyboard }) => Keyboard.setAccessoryBarVisible({ isVisible: false }))
		.catch(() => {});
}

/**
 * Records how much width a scroll bar takes, so the composer can hold the same
 * edge as the bubbles above it.
 *
 * Whether scroll bars overlay the content or sit beside it is a system setting
 * ("Show scroll bars" in Appearance), not something CSS can ask about — and with
 * "Always" the transcript's column loses width the composer does not. Measured
 * once: it takes a relaunch to change.
 */
function measureScrollbar(): void {
	const probe = document.createElement("div");
	probe.style.cssText =
		"position:absolute;top:-9999px;width:100px;height:100px;overflow-y:scroll";
	document.body.append(probe);
	const width = probe.offsetWidth - probe.clientWidth;
	probe.remove();
	/* Desktop scrollbars are native: overlay scrollbars really consume zero
	 * layout width, while non-overlay scrollbars report their full gutter. The
	 * phone keeps its overlaid composer flush with the viewport. */
	document.documentElement.style.setProperty(
		"--scrollbar",
		document.documentElement.classList.contains("web") ? "0px" : `${width}px`,
	);
}

measureScrollbar();

createRoot(document.getElementById("root")!).render(
	<StrictMode>
		<App />
	</StrictMode>,
);

installDragRelease();
