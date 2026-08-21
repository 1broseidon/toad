import { useId } from "react";
import type { Face } from "../../shared/face";

/**
 * A teammate's chosen face, rendered.
 *
 * The geometry is the activity mark's — a rounded bar with two eyes sitting on
 * its top edge, slit pupils — scaled into a 64-unit disc. Every part is either
 * ink or disc showing through the ink; no second colour, no gradient, no
 * outline. Parts inside the disc are clipped to it; the hat is not, because a
 * hat that cannot cross the rim is a sticker.
 *
 * Below 32px the fine marks drop and every stroke gains weight — the same
 * concession the mark makes in the composer. 30px (the rail) is the size this
 * was judged at; everything else is a bonus.
 */

/* The bar: width, height, corner, eye radius, eye spacing from centre, and how
 * far the eye centre sits above (+) or below (−) the bar's top edge. */
const BODY = {
	round: { w: 42, h: 15, rx: 7.5, r: 8.4, dx: 12, lift: 0 },
	wide: { w: 50, h: 12, rx: 6, r: 7.8, dx: 16, lift: 0 },
	tall: { w: 36, h: 19, rx: 7, r: 7.8, dx: 10.5, lift: 1.5 },
	squat: { w: 52, h: 10, rx: 5, r: 7.2, dx: 15, lift: -2 },
} as const;

/* Where the bar's centre sits: a touch below the box centre so bar + eyes are
 * optically centred, and so the hats have somewhere to go. */
const BAR_CY = 35;

/* Eyes: per-eye lid (vertical scale), and small radius / spacing nudges.
 * `asym` is the raised-brow look: one open, one half. */
const EYES = {
	round: { lid: [1, 1], dr: 0, ddx: 0 },
	half: { lid: [0.6, 0.6], dr: 0, ddx: 0 },
	wide: { lid: [1, 1], dr: 1.2, ddx: 1 },
	narrow: { lid: [0.42, 0.42], dr: -0.4, ddx: 0 },
	asym: { lid: [1, 0.56], dr: 0, ddx: 0 },
} as const;

type Eye = { cx: number; cy: number; r: number; lid: number };
type Layout = {
	bar: { x: number; y: number; w: number; h: number; rx: number; cy: number };
	eyes: [Eye, Eye];
	/** Top of the head: where a hat rests. */
	crown: number;
};

function layoutOf(face: Face): Layout {
	const b = BODY[face.body] ?? BODY.round;
	const e = EYES[face.eyes] ?? EYES.round;
	const top = BAR_CY - b.h / 2;
	const r = b.r + e.dr;
	const dx = b.dx + e.ddx;
	const cy = top - b.lift;
	return {
		bar: { x: 32 - b.w / 2, y: top, w: b.w, h: b.h, rx: b.rx, cy: BAR_CY },
		eyes: [
			{ cx: 32 - dx, cy, r, lid: e.lid[0] },
			{ cx: 32 + dx, cy, r, lid: e.lid[1] },
		],
		crown: Math.min(cy - r * Math.max(e.lid[0], e.lid[1]), top),
	};
}

function EyePair({ eye, disc, small }: { eye: Eye; disc: string; small: boolean }) {
	const ry = eye.r * eye.lid;
	const pw = eye.r * 1.05;
	// The pupil floor never takes more than 78% of the lid opening, so a
	// narrow eye at rail size stays a slit rather than vanishing.
	const ph = Math.max(1.5, Math.min(ry * 0.78, Math.max(small ? 3.2 : 2.4, eye.r * 0.38 * eye.lid)));
	return (
		<>
			<ellipse cx={eye.cx} cy={eye.cy} rx={eye.r} ry={ry} fill="var(--face-ink)" />
			<rect x={eye.cx - pw / 2} y={eye.cy - ph / 2} width={pw} height={ph} rx={ph / 2} fill={disc} />
		</>
	);
}

function Mouth({ face, L, disc, small }: { face: Face; L: Layout; disc: string; small: boolean }) {
	const { bar } = L;
	const y = bar.cy + bar.h * 0.14;
	const half = bar.w * 0.2;
	const sw = small ? 2.6 : 2;
	const stroke = { fill: "none", stroke: disc, strokeWidth: sw, strokeLinecap: "round" as const };
	switch (face.mouth) {
		case "flat":
			return <path d={`M${32 - half} ${y} H${32 + half}`} {...stroke} />;
		case "smile":
			return <path d={`M${32 - half} ${y - 1} Q32 ${y + 3.2} ${32 + half} ${y - 1}`} {...stroke} />;
		case "smirk":
			return (
				<path
					d={`M${32 - half} ${y + 0.6} Q${32 + half * 0.4} ${y + 2.6} ${32 + half} ${y - 1.6}`}
					{...stroke}
				/>
			);
		case "open":
			return <ellipse cx={32} cy={y + 0.4} rx={3.4} ry={2.2} fill={disc} />;
		default:
			return null;
	}
}

function Marks({ face, L, disc, small }: { face: Face; L: Layout; disc: string; small: boolean }) {
	const { bar, eyes } = L;
	switch (face.marks) {
		case "spots": {
			if (small) return null;
			const pts: Array<[number, number, number]> = [
				[-0.32, 0.18, 1.5],
				[0.12, -0.12, 1.2],
				[0.34, 0.2, 1.1],
			];
			return (
				<>
					{pts.map(([fx, fy, r]) => (
						<circle key={fx} cx={32 + bar.w * fx} cy={bar.cy + bar.h * fy} r={r} fill={disc} />
					))}
				</>
			);
		}
		case "stripe":
			return <rect x={30.9} y={bar.y} width={2.2} height={bar.h} fill={disc} />;
		case "freckles": {
			if (small) return null;
			const y = bar.y + bar.h + 3.2;
			return (
				<>
					{[-0.34, -0.27, -0.3, 0.34, 0.27, 0.3].map((fx, i) => (
						<circle
							key={`${fx}-${i}`}
							cx={32 + bar.w * fx}
							cy={y + (i % 3) * 1.6}
							r={0.8}
							fill="var(--face-ink)"
							opacity={0.7}
						/>
					))}
				</>
			);
		}
		case "monocle": {
			const e = eyes[1];
			const R = e.r + 2.4;
			const sw = small ? 2 : 1.6;
			return (
				<>
					<circle cx={e.cx} cy={e.cy} r={R} fill="none" stroke="var(--face-ink)" strokeWidth={sw} />
					<path
						d={`M${e.cx + R * 0.7} ${e.cy + R * 0.7} q2 4 0.6 ${bar.h * 0.7}`}
						fill="none"
						stroke="var(--face-ink)"
						strokeWidth={sw * 0.8}
						strokeLinecap="round"
					/>
				</>
			);
		}
		default:
			return null;
	}
}

function Hat({ face, L, disc, small }: { face: Face; L: Layout; disc: string; small: boolean }) {
	const { eyes, crown: top } = L;
	const [l, r] = eyes;
	// Hat strokes are the thinnest ink on the face; below 32px they gain
	// weight, the same concession the mouth makes.
	const lw = (w: number) => (small ? w + 0.7 : w);
	const dot = small ? 2.6 : 2.2;
	const line = (w: number) => ({
		fill: "none",
		stroke: "var(--face-ink)",
		strokeWidth: lw(w),
		strokeLinecap: "round" as const,
		strokeLinejoin: "round" as const,
	});
	switch (face.hat) {
		/* Three points on a band, sat across the eye tops so it unions with
		 * them. Short: at 30px a tall crown is a spike. */
		case "crown": {
			const y = top + 1.2;
			return (
				<path
					d={`M22 ${y} V${y - 4.5} L27 ${y - 1.5} L32 ${y - 7.5} L37 ${y - 1.5} L42 ${y - 4.5} V${y} Z`}
					fill="var(--face-ink)"
				/>
			);
		}
		/* A dome over both eyes with the bobble above. The rib line is a
		 * hairline of disc; at rail size it is sub-pixel shimmer, so small
		 * drops it and the dome alone reads as a cap. */
		case "beanie": {
			const x0 = l.cx - l.r + 1;
			const x1 = r.cx + r.r - 1;
			const y = top + 2.5;
			return (
				<>
					<path d={`M${x0} ${y} Q32 ${top - 9} ${x1} ${y} Z`} fill="var(--face-ink)" />
					{!small && (
						<path
							d={`M${x0 + 1} ${y} Q32 ${top - 7.2} ${x1 - 1} ${y}`}
							fill="none"
							stroke={disc}
							strokeWidth={1.3}
						/>
					)}
					<circle cx={32} cy={top - 8.6} r={dot} fill="var(--face-ink)" />
				</>
			);
		}
		/* A tilted lens resting on one eye, stem up. */
		case "beret":
			return (
				<>
					<g transform={`rotate(-9 34 ${top - 2})`}>
						<ellipse cx={35} cy={top - 1.8} rx={13} ry={3.6} fill="var(--face-ink)" />
					</g>
					<path d={`M39.5 ${top - 5.2} l1.4 -3`} {...line(1.8)} />
				</>
			);
		case "halo":
			return <ellipse cx={32} cy={top - 7.5} rx={11.5} ry={3} {...line(2)} />;
		/* Two stalks out of the eye tops, going up and out. The dots cross the
		 * rim at 30px, which is the point of an antenna. */
		case "antenna":
			return (
				<>
					<path d={`M${l.cx} ${l.cy - l.r * l.lid + 1} L${l.cx - 4} ${top - 9}`} {...line(2)} />
					<path d={`M${r.cx} ${r.cy - r.r * r.lid + 1} L${r.cx + 4} ${top - 9}`} {...line(2)} />
					<circle cx={l.cx - 4} cy={top - 9} r={dot} fill="var(--face-ink)" />
					<circle cx={r.cx + 4} cy={top - 9} r={dot} fill="var(--face-ink)" />
				</>
			);
		/* One stem from between the eyes, one leaf. */
		case "sprout":
			return (
				<>
					<path d={`M32 ${top + 3} V${top - 7}`} {...line(2)} />
					<path d={`M32 ${top - 5} q-1.5 -5.5 -6.5 -6.5 q1 5.5 6.5 6.5 z`} fill="var(--face-ink)" />
				</>
			);
		default:
			return null;
	}
}

export function FaceIcon({ face, size }: { face: Face; size: number }) {
	const clip = useId();
	const small = size < 32;
	const L = layoutOf(face);
	const disc = `oklch(72% 0.13 ${face.hue})`;
	const deep = `oklch(63% 0.13 ${face.hue})`;
	const { bar } = L;
	return (
		<svg
			viewBox="0 0 64 64"
			width={size}
			height={size}
			shapeRendering="geometricPrecision"
			aria-hidden="true"
			focusable="false"
			style={{ display: "block", overflow: "visible" }}
		>
			<defs>
				<clipPath id={clip}>
					<circle cx={32} cy={32} r={32} />
				</clipPath>
			</defs>
			<circle cx={32} cy={32} r={32} fill={disc} />
			<g clipPath={`url(#${clip})`}>
				{face.pattern === "spotted" && (
					<>
						{[
							[10, 46, 2.2],
							[54, 44, 2.6],
							[16, 16, 1.8],
							[50, 14, 2],
							[40, 56, 1.8],
						].map(([x, y, r]) => (
							<circle key={`${x}-${y}`} cx={x} cy={y} r={r} fill={deep} />
						))}
					</>
				)}
				{/* The lower half of the disc darker, the line a little above the
				    bar's midline: eyes above water, the bar mostly under it. */}
				{face.pattern === "waterline" && (
					<rect x={0} y={bar.cy - 1} width={64} height={64} fill={deep} />
				)}
				<rect x={bar.x} y={bar.y} width={bar.w} height={bar.h} rx={bar.rx} fill="var(--face-ink)" />
				<EyePair eye={L.eyes[0]} disc={disc} small={small} />
				<EyePair eye={L.eyes[1]} disc={disc} small={small} />
				<Mouth face={face} L={L} disc={disc} small={small} />
				<Marks face={face} L={L} disc={disc} small={small} />
			</g>
			<Hat face={face} L={L} disc={disc} small={small} />
		</svg>
	);
}
