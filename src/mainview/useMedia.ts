import { useEffect, useState } from "react";

/**
 * Whether a media query currently matches, kept in sync as the window resizes.
 *
 * A desktop window is dragged to whatever width its owner feels like, so layout
 * that depends on width has to be state rather than a one-time measurement.
 */
export function useMedia(query: string): boolean {
	const [matches, setMatches] = useState(() => window.matchMedia(query).matches);

	useEffect(() => {
		const list = window.matchMedia(query);
		const update = () => setMatches(list.matches);
		// The query may have changed between render and effect.
		update();
		list.addEventListener("change", update);
		return () => list.removeEventListener("change", update);
	}, [query]);

	return matches;
}
