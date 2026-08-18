import { useEffect, useRef } from "react";
import type { ActivityPhase } from "../useActivity";

/**
 * The working indicator, as three marks that change formation.
 *
 * It is always the same three marks. That is the whole idea: thinking is them
 * circling wide and slow, a tool is them turning tight and stepped like
 * something geared, and typing is them falling into the row everyone already
 * reads as typing. Because nothing is added or taken away between states, the
 * change between them is a movement rather than a swap — the dots are where the
 * glyph went, not what replaced it.
 */

const MARKS = 3;
const TURN = (Math.PI * 2) / MARKS;

/** Where the marks sit in the viewBox, and how big they are drawn. */
const CENTER = { x: 14, y: 8 };
const DOT_R = 3.2;
const ROW_GAP = 8.5;
const ORBIT_THINKING = 5.6;
const ORBIT_TOOL = 4;

/** How long a change of formation takes. Long enough to read as one gesture. */
const MORPH = 300;

const REDUCED_MOTION = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

type Pose = { x: number; y: number; scale: number; alpha: number };

export function Glyph({ phase }: { phase: Exclude<ActivityPhase, "idle"> }) {
	const marks = useRef<(SVGGElement | null)[]>([]);

	// The formation being left, and when the leaving started. Held in refs so a
	// morph that is already running is never restarted by a re-render.
	const from = useRef<ActivityPhase>(phase);
	const since = useRef(0);
	const current = useRef(phase);

	useEffect(() => {
		if (current.current === phase) return;
		from.current = current.current;
		current.current = phase;
		since.current = performance.now();
	}, [phase]);

	useEffect(() => {
		let frame = 0;
		const started = performance.now();

		const draw = (now: number) => {
			// A single clock for both formations, so the one being left keeps
			// running while it is left. Freezing it would show a stutter at the
			// exact moment attention is on the change.
			const t = REDUCED_MOTION ? 0 : (now - started) / 1000;
			const mix = REDUCED_MOTION ? 1 : ease(Math.min(1, (now - since.current) / MORPH));

			for (let index = 0; index < MARKS; index++) {
				const node = marks.current[index];
				if (!node) continue;
				const pose =
					mix >= 1
						? poseOf(current.current, index, t)
						: blend(poseOf(from.current, index, t), poseOf(current.current, index, t), mix);
				node.setAttribute(
					"transform",
					`translate(${(CENTER.x + pose.x).toFixed(2)} ${(CENTER.y + pose.y).toFixed(2)}) scale(${pose.scale.toFixed(3)})`,
				);
				node.setAttribute("opacity", pose.alpha.toFixed(3));
			}

			if (!REDUCED_MOTION) frame = requestAnimationFrame(draw);
		};

		frame = requestAnimationFrame(draw);
		return () => cancelAnimationFrame(frame);
	}, []);

	return (
		<svg
			className="glyph"
			viewBox="0 0 28 16"
			width="28"
			height="16"
			aria-hidden="true"
			focusable="false"
		>
			{Array.from({ length: MARKS }, (_, index) => (
				<g
					key={index}
					ref={(node) => {
						marks.current[index] = node;
					}}
				>
					<circle r={DOT_R} />
				</g>
			))}
		</svg>
	);
}

// ---------------------------------------------------------------------------
// Formations
// ---------------------------------------------------------------------------

/** Where mark `index` stands in a given formation, `t` seconds in. */
function poseOf(phase: ActivityPhase, index: number, t: number): Pose {
	switch (phase) {
		/* Wide, slow, and breathing. Nothing about it is in a hurry, which is the
		 * only honest thing to say about a model that is still deciding. */
		case "thinking": {
			const angle = t * 0.9 + index * TURN;
			return {
				x: Math.cos(angle) * ORBIT_THINKING,
				y: Math.sin(angle) * ORBIT_THINKING,
				scale: 0.86 + 0.14 * Math.sin(t * 1.7 + index * 2.1),
				alpha: 0.5 + 0.5 * (0.5 + 0.5 * Math.sin(t * 1.7 + index * 2.1)),
			};
		}

		/* Tight and geared: a sixth of a turn at a time, eased into each stop.
		 * A tool call is a discrete thing happening, and stepped motion is how you
		 * say discrete without a label. */
		case "tool": {
			const angle = ratchet(t) + index * TURN;
			return {
				x: Math.cos(angle) * ORBIT_TOOL,
				y: Math.sin(angle) * ORBIT_TOOL,
				scale: 0.92,
				alpha: 1,
			};
		}

		/* The dots. Every messages app draws them this way and there is no version
		 * of this worth inventing. */
		default: {
			const beat = (t * 1000) / 1400 - index * 0.125;
			return {
				x: (index - 1) * ROW_GAP,
				y: 0,
				scale: 1,
				alpha: 0.28 + 0.72 * (0.5 + 0.5 * Math.cos(beat * Math.PI * 2)),
			};
		}
	}
}

/** A sixth of a turn every 420ms, eased in and out of each stop. */
function ratchet(t: number): number {
	const steps = t / 0.42;
	const landed = Math.floor(steps);
	return (landed + ease(steps - landed)) * (Math.PI / 3);
}

const ease = (p: number): number => (p < 0.5 ? 4 * p ** 3 : 1 - (-2 * p + 2) ** 3 / 2);

const blend = (a: Pose, b: Pose, mix: number): Pose => ({
	x: a.x + (b.x - a.x) * mix,
	y: a.y + (b.y - a.y) * mix,
	scale: a.scale + (b.scale - a.scale) * mix,
	alpha: a.alpha + (b.alpha - a.alpha) * mix,
});
