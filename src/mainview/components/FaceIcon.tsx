import { useId, type ReactNode } from "react";
import { curateFace, type Face } from "../../shared/face";

/**
 * A teammate's chosen face, rendered — with the mark's own construction.
 *
 * The mark is a body with two full-circle eye domes centred on its top edge
 * and the pupils punched through by mask: one shape, one colour, nothing
 * painted on top. Every face here is that drawing, varied. Expression lives
 * in the punched pupil aperture and lids — the domes never squash — and the
 * mouth, freckles, monocle and the beanie's brim are all punches too, so on
 * a waterline face the pupil slit genuinely shows the water through the eye.
 *
 * Two small feet ground the silhouette as one creature; hats stand clear of
 * it, because a hat the head's own ink that does not clear the head is just
 * a taller head. Below 32px the fine punches drop and the rest gain weight —
 * the same concession the mark makes in the composer.
 */

/* Body, per silhouette: width, height, eye spacing from centre, dome radius.
 * Narrower than the mark throughout — the mark is cropped by its waterline,
 * but a face floats whole in its disc and needs pond around it. */
const BODY = {
	round: { w: 40, h: 15, dx: 10, r: 9.5 },
	wide: { w: 46, h: 12.5, dx: 11.5, r: 8.8 },
	tall: { w: 34, h: 18, dx: 9, r: 9.2 },
	squat: { w: 44, h: 10.5, dx: 11, r: 8.2 },
} as const;

type Geo = {
	w: number;
	h: number;
	dx: number;
	r: number;
	/** Body top — the line the dome centres sit on. */
	ty: number;
	cxL: number;
	cxR: number;
};

function geoOf(face: Face): Geo {
	const b = BODY[face.body] ?? BODY.round;
	const ty = 34 - (b.h - 14) / 2;
	return { ...b, ty, cxL: 32 - b.dx, cxR: 32 + b.dx };
}

/* ------------------------------------------------------------ the punches
 * Everything below returns black shapes for the mask: where the ink is
 * carved away and the disc (and its pattern) shows through. */

function Gaze({ face, g, small }: { face: Face; g: Geo; small: boolean }) {
	const slit = (cx: number, w: number, h: number, dy = 0) => (
		<rect key={`${cx}-s`} x={cx - w / 2} y={g.ty + dy - h / 2} width={w} height={h} rx={h / 2} fill="#000" />
	);
	const lid = (cx: number, drop: number) => (
		<rect key={`${cx}-l`} x={cx - g.r - 1} y={g.ty - g.r - 3} width={g.r * 2 + 2} height={g.r * drop + 3} rx={2} fill="#000" />
	);
	const min = small ? 3.2 : 0;
	switch (face.eyes) {
		case "wide":
			return (
				<>
					{slit(g.cxL, 9, 7)}
					{slit(g.cxR, 9, 7)}
				</>
			);
		case "narrow":
			return (
				<>
					{slit(g.cxL, 11, Math.max(2.6, min))}
					{slit(g.cxR, 11, Math.max(2.6, min))}
				</>
			);
		case "half":
			return (
				<>
					{lid(g.cxL, 0.52)}
					{lid(g.cxR, 0.52)}
					{slit(g.cxL, 10, Math.max(3.4, min), 1.5)}
					{slit(g.cxR, 10, Math.max(3.4, min), 1.5)}
				</>
			);
		case "asym":
			return (
				<>
					{slit(g.cxL, 11, 4.2)}
					{lid(g.cxR, 0.45)}
					{slit(g.cxR, 10, Math.max(3, min), 1)}
				</>
			);
		default:
			// round — the mark's own slits.
			return (
				<>
					{slit(g.cxL, 11, 4.2)}
					{slit(g.cxR, 11, 4.2)}
				</>
			);
	}
}

function Mouth({ face, g, small }: { face: Face; g: Geo; small: boolean }) {
	const y = g.ty + g.h * (g.h <= 14 ? 0.52 : 0.58);
	const half = g.w * 0.19;
	const stroke = {
		fill: "none",
		stroke: "#000",
		strokeWidth: small ? 2.8 : 2.2,
		strokeLinecap: "round" as const,
	};
	switch (face.mouth) {
		case "flat":
			return <path d={`M${32 - half} ${y} H${32 + half}`} {...stroke} />;
		case "smile":
			return <path d={`M${32 - half} ${y - 1.2} Q32 ${y + 3.4} ${32 + half} ${y - 1.2}`} {...stroke} />;
		case "smirk":
			return (
				<path
					d={`M${32 - half} ${y + 0.6} Q${32 + half * 0.35} ${y + 2.8} ${32 + half} ${y - 2}`}
					{...stroke}
				/>
			);
		case "open":
			return <ellipse cx={32} cy={y} rx={3.6} ry={2.5} fill="#000" />;
		default:
			return null;
	}
}

/** Freckles and the monocle are carved; retired marks carve nothing. */
function MarkPunches({ face, g, small }: { face: Face; g: Geo; small: boolean }) {
	if (face.marks === "freckles" && !small) {
		/* On shallow bodies the mouth rides high; the triads lift with it so
		 * the corner dots never kiss a smile's endpoints. */
		const dy = g.h <= 12.5 ? -0.8 : 0;
		return (
			<>
				{[g.cxL, g.cxR].map((cx) => (
					<g key={cx}>
						<circle cx={cx - 3.2} cy={g.ty + 4.4 + dy} r={1} fill="#000" />
						<circle cx={cx} cy={g.ty + 6.4 + dy} r={1} fill="#000" />
						<circle cx={cx + 3.2} cy={g.ty + 4.4 + dy} r={1} fill="#000" />
					</g>
				))}
			</>
		);
	}
	if (face.marks === "monocle") {
		const R = g.r * 0.72;
		const sw = small ? 2 : 1.5;
		return (
			<>
				<circle cx={g.cxR} cy={g.ty} r={R} fill="none" stroke="#000" strokeWidth={sw} />
				{!small && (
					<path
						d={`M${g.cxR + R * 0.75} ${g.ty + R * 0.75} q1.4 3.6 0.3 ${g.h * 0.55}`}
						fill="none"
						stroke="#000"
						strokeWidth={sw * 0.8}
						strokeLinecap="round"
					/>
				)}
			</>
		);
	}
	return null;
}

/* ------------------------------------------------------------------ hats */

function hatParts(face: Face, g: Geo, small: boolean): { ink: ReactNode; punch: ReactNode } {
	const top = g.ty - g.r;
	const line = (w: number) => ({
		fill: "none",
		stroke: "var(--face-ink)",
		strokeWidth: small ? w + 0.6 : w,
		strokeLinecap: "round" as const,
		strokeLinejoin: "round" as const,
	});
	switch (face.hat) {
		case "sprout":
			return {
				ink: (
					<>
						<path d={`M32 ${top + 4} V${top - 6.5}`} {...line(2.2)} />
						<path d={`M32 ${top - 4.5} q-1.2 -6 -7 -7 q0.8 6 7 7 z`} fill="var(--face-ink)" />
					</>
				),
				punch: null,
			};
		case "halo":
			return { ink: <ellipse cx={32} cy={top - 6.5} rx={11} ry={2.8} {...line(2)} />, punch: null };
		case "antenna": {
			const dot = small ? 2.6 : 2.2;
			return {
				ink: (
					<>
						<path d={`M${g.cxL} ${top + 2} L${g.cxL - 4.5} ${top - 7.5}`} {...line(2)} />
						<path d={`M${g.cxR} ${top + 2} L${g.cxR + 4.5} ${top - 7.5}`} {...line(2)} />
						<circle cx={g.cxL - 4.5} cy={top - 7.5} r={dot} fill="var(--face-ink)" />
						<circle cx={g.cxR + 4.5} cy={top - 7.5} r={dot} fill="var(--face-ink)" />
					</>
				),
				punch: null,
			};
		}
		case "beanie": {
			/* The cap is the head's own ink, so it only exists where it stands
			 * proud of the silhouette: a tall knit crown clearing the domes,
			 * with the brim carved where it meets them. */
			const x0 = g.cxL - g.r * 1.02;
			const x1 = g.cxR + g.r * 1.02;
			const y0 = g.ty - g.r * 0.45;
			const crown = top - 17;
			const apex = (y0 + crown) / 2;
			return {
				ink: (
					<>
						<path
							d={`M${x0} ${y0} Q32 ${crown} ${x1} ${y0} Q32 ${y0 + 3.6} ${x0} ${y0} Z`}
							fill="var(--face-ink)"
						/>
						<circle cx={32} cy={apex - 1.8} r={2.6} fill="var(--face-ink)" />
					</>
				),
				punch: (
					<>
						<path
							d={`M${x0 + 1.5} ${y0 + 0.3} Q32 ${y0 + 3.8} ${x1 - 1.5} ${y0 + 0.3}`}
							fill="none"
							stroke="#000"
							strokeWidth={small ? 2 : 1.5}
						/>
						{!small && (
							<path
								d={`M${x0 + 5} ${y0 - 3.6} Q32 ${crown + 6.5} ${x1 - 5} ${y0 - 3.6}`}
								fill="none"
								stroke="#000"
								strokeWidth={1.2}
							/>
						)}
					</>
				),
			};
		}
		case "crown": {
			/* Base sits just above the pupil line so its corners never clip
			 * the inner slits on close-set bodies. */
			const y = g.ty - 2.5;
			return {
				ink: (
					<path
						d={`M25.5 ${y} V${y - 5} L28.7 ${y - 2.6} L32 ${y - 7.6} L35.3 ${y - 2.6} L38.5 ${y - 5} V${y} Z`}
						fill="var(--face-ink)"
					/>
				),
				punch: null,
			};
		}
		case "beret":
			return {
				ink: (
					<>
						<g transform={`rotate(-9 ${g.cxR} ${top - 1})`}>
							<ellipse cx={g.cxR + 1} cy={top - 1.5} rx={11.5} ry={3.2} fill="var(--face-ink)" />
						</g>
						<path d={`M${g.cxR + 5.5} ${top - 5} l1.2 -2.8`} {...line(1.8)} />
					</>
				),
				punch: null,
			};
		default:
			return { ink: null, punch: null };
	}
}

/* -------------------------------------------------------------- patterns */

function Pond({ face, g, deep, disc }: { face: Face; g: Geo; deep: string; disc: string }) {
	switch (face.pattern) {
		case "waterline":
			return <rect x={0} y={g.ty + g.h * 0.5} width={64} height={64} fill={deep} />;
		case "ripples": {
			/* Water surface lines in the margins beside the body — where the
			 * disc actually has room — not arcs hidden underneath it. */
			const y1 = g.ty + g.h * 0.5;
			const y2 = y1 + 7.5;
			const bx = g.w / 2 + 2.5;
			const stroke = { fill: "none", stroke: deep, strokeWidth: 3, strokeLinecap: "round" as const };
			return (
				<>
					<path d={`M3 ${y1} H${32 - bx} M${32 + bx} ${y1} H61`} {...stroke} />
					<path d={`M8 ${y2} H${32 - bx - 4} M${32 + bx + 4} ${y2} H56`} {...stroke} />
				</>
			);
		}
		case "lilypad":
		case "spotted": {
			/* The pad the toad sits on, wide enough to show either side of the
			 * body, with the wedge notch cut in disc colour. */
			const cy = g.ty + g.h + 2.5;
			const rx = g.w / 2 + 7;
			return (
				<>
					<ellipse cx={32} cy={cy} rx={rx} ry={5} fill={deep} />
					<path d={`M32 ${cy} L${32 + rx + 1} ${cy - 3.6} L${32 + rx + 1} ${cy + 0.6} Z`} fill={disc} />
				</>
			);
		}
		default:
			return null;
	}
}

export function FaceIcon({ face: raw, size }: { face: Face; size: number }) {
	const id = useId();
	const small = size < 32;
	/* Stored faces predate the veto list's newest rules; curation runs at
	 * render so an old tangle (a beret AND a monocle on one dome) displays
	 * as the character it meant to be. */
	const face = curateFace(raw);
	const g = geoOf(face);
	const disc = `oklch(72% 0.13 ${face.hue})`;
	/* Deep is the pond under the light: 17 points below the disc with a bit
	 * more chroma, so a pattern survives 52px instead of being a rumour. */
	const deep = `oklch(55% 0.15 ${face.hue})`;
	const hat = hatParts(face, g, small);
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
				<clipPath id={`${id}c`}>
					<circle cx={32} cy={32} r={32} />
				</clipPath>
				{/* Two masks, not one: a lid carves the dome, never the hat
				    standing over it — with a shared mask a half-lidded toad's
				    eyelids erased its own antenna stalks. */}
				<mask id={`${id}m`} maskUnits="userSpaceOnUse" x={-8} y={-8} width={80} height={80}>
					<rect x={-8} y={-8} width={80} height={80} fill="#fff" />
					<Gaze face={face} g={g} small={small} />
					<Mouth face={face} g={g} small={small} />
					<MarkPunches face={face} g={g} small={small} />
				</mask>
				<mask id={`${id}h`} maskUnits="userSpaceOnUse" x={-8} y={-8} width={80} height={80}>
					<rect x={-8} y={-8} width={80} height={80} fill="#fff" />
					{hat.punch}
				</mask>
			</defs>
			<circle cx={32} cy={32} r={32} fill={disc} />
			<g clipPath={`url(#${id}c)`}>
				<Pond face={face} g={g} deep={deep} disc={disc} />
			</g>
			<g mask={`url(#${id}m)`} clipPath={`url(#${id}c)`}>
				<rect
					x={32 - g.w / 2}
					y={g.ty}
					width={g.w}
					height={g.h}
					rx={Math.min(6.5, g.h / 3)}
					fill="var(--face-ink)"
				/>
				<circle cx={g.cxL} cy={g.ty} r={g.r} fill="var(--face-ink)" />
				<circle cx={g.cxR} cy={g.ty} r={g.r} fill="var(--face-ink)" />
				<rect x={32 - g.w * 0.27 - 3} y={g.ty + g.h - 1} width={6} height={3.9} rx={1.9} fill="var(--face-ink)" />
				<rect x={32 + g.w * 0.27 - 3} y={g.ty + g.h - 1} width={6} height={3.9} rx={1.9} fill="var(--face-ink)" />
			</g>
			<g mask={`url(#${id}h)`}>{hat.ink}</g>
		</svg>
	);
}
