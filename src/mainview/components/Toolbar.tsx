import { type ReactNode, useLayoutEffect, useRef } from "react";

/*
 * The band across the top of each pane. The window has no titlebar of its own,
 * so this is what drags it.
 *
 * Electrobun recovers `-webkit-app-region` — a property WKWebView drops — by
 * mirroring the page's stylesheets into a custom property. In a packaged build
 * our CSS arrives over the `views://` scheme, which it cannot fetch, so the
 * declaration in `index.css` only ever takes effect under the dev server. These
 * marker classes are its other path: it looks for them on the element itself,
 * which works either way.
 */
const DRAG = "electrobun-webkit-app-region-drag";
const NO_DRAG = "electrobun-webkit-app-region-no-drag";

/* A drag region covers its descendants, so every control inside has to opt back
 * out or the press that should click it moves the window instead. Tagging them
 * from here rather than at each call site means a control added later — or one
 * that only appears in some states, like the model picker — cannot forget to. */
const CONTROLS = "button, select, input, textarea, a[href], [role='button']";

type Props = {
	as?: "div" | "header";
	className?: string;
	/** Lights the hairline beneath the band once content has scrolled under it. */
	scrolled?: boolean;
	children?: ReactNode;
};

export function Toolbar({ as: Element = "div", className = "", scrolled, children }: Props) {
	const band = useRef<HTMLElement>(null);

	useLayoutEffect(() => {
		for (const control of band.current?.querySelectorAll(CONTROLS) ?? []) {
			control.classList.add(NO_DRAG);
		}
	});

	return (
		<Element
			ref={band as React.RefObject<HTMLDivElement & HTMLElement>}
			className={`toolbar ${DRAG} ${scrolled === undefined ? "" : "toolbar-edge"} ${className}`}
			data-scrolled={scrolled}
		>
			{children}
		</Element>
	);
}
