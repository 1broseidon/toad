/**
 * A teammate's face: the activity mark, wearing something it chose.
 *
 * Parts are enums, never free drawing. At creation the agent is handed its
 * persona and these enums and asked to answer with one JSON object — it picks
 * who it looks like, Toad guarantees every pick renders clean. `curateFace`
 * is that guarantee: a short veto list over the few combinations the eye
 * rejects, run on every face regardless of where it came from.
 *
 * Geometry lives in the renderer (mainview/components/FaceIcon.tsx); this
 * module is only the vocabulary and the judgement, because the main process
 * needs both to validate an agent's answer without owning a canvas.
 */

export type FaceBody = "round" | "wide" | "tall" | "squat";
export type FaceEyes = "round" | "half" | "wide" | "narrow" | "asym";
export type FaceMouth = "none" | "flat" | "smile" | "smirk" | "open";
export type FaceHat = "none" | "crown" | "beanie" | "beret" | "halo" | "antenna" | "sprout";
/* "spots" and "stripe" are retired from the vocabulary but stay in the type:
 * a stored face may still wear them, and curation reads them as kin. */
export type FaceMarks = "none" | "spots" | "stripe" | "freckles" | "monocle";
/* "spotted" likewise — a stored spotted disc reads as a lilypad now. */
export type FacePattern = "solid" | "spotted" | "waterline" | "ripples" | "lilypad";

export type Face = {
	v: 1;
	/** OKLCH hue of the disc; lightness and chroma are fixed app-wide. */
	hue: number;
	body: FaceBody;
	eyes: FaceEyes;
	mouth: FaceMouth;
	hat: FaceHat;
	marks: FaceMarks;
	pattern: FacePattern;
};

export const FACE_PARTS = {
	body: ["round", "wide", "tall", "squat"],
	eyes: ["round", "half", "wide", "narrow", "asym"],
	mouth: ["none", "flat", "smile", "smirk", "open"],
	hat: ["none", "crown", "beanie", "beret", "halo", "antenna", "sprout"],
	marks: ["none", "freckles", "monocle"],
	pattern: ["solid", "waterline", "ripples", "lilypad"],
} as const;

/** The seven identity hues the app already ships as --face-1…7. */
export const FACE_HUES = [70, 122, 168, 210, 252, 294, 330];

/**
 * The veto list. Everything here is a combination the enums allow and the eye
 * rejects at 30px, fixed by the smallest move that keeps the agent's intent.
 */
export function curateFace(face: Face): Face {
	const next = { ...face };
	// Retired parts read as their nearest living kin.
	if (next.marks === "spots") next.marks = "freckles";
	if (next.marks === "stripe") next.marks = "none";
	if (next.pattern === "spotted") next.pattern = "lilypad";
	// One dome carries one accessory. A beret and a monocle both anchor to
	// the right eye; together they read as a tangle, not a character.
	if (next.hat === "beret" && next.marks === "monocle") next.marks = "none";
	// A monocle under a beanie is a ring poking out of a cap.
	if (next.hat === "beanie" && next.marks === "monocle") next.marks = "none";
	// A monocle ringing a closed slit reads as a target, not an eye.
	if (next.marks === "monocle" && next.eyes === "narrow") next.eyes = "half";
	// A monocle around a wide-open pupil fills its own ring — also a target.
	if (next.marks === "monocle" && next.eyes === "wide") next.eyes = "round";
	// Under a beanie the brim owns the dome tops: wide pupils graze it and
	// lids would carve into the cap, so the gaze simplifies.
	if (next.hat === "beanie" && (next.eyes === "wide" || next.eyes === "half" || next.eyes === "asym"))
		next.eyes = "round";
	// The squat bar is too shallow to hold an open mouth clear of the rim.
	if (next.mouth === "open" && next.body === "squat") next.mouth = "smile";
	// Identity never sits in the app's danger band (red is for errors).
	if (next.hue > 8 && next.hue < 42) next.hue = 70;
	return next;
}

/**
 * Reads a Face out of whatever an agent said. Agents wrap JSON in prose and
 * fences no matter how firmly they are asked not to, so this scans for the
 * first balanced object that validates rather than trusting the whole reply
 * to be one. Returns null when nothing in the text is a face.
 */
export function parseFace(text: string): Face | null {
	for (const candidate of jsonObjects(text)) {
		const face = validate(candidate);
		if (face) return curateFace(face);
	}
	return null;
}

function* jsonObjects(text: string): Generator<unknown> {
	for (let start = text.indexOf("{"); start !== -1; start = text.indexOf("{", start + 1)) {
		let depth = 0;
		for (let i = start; i < text.length; i++) {
			if (text[i] === "{") depth++;
			else if (text[i] === "}" && --depth === 0) {
				try {
					yield JSON.parse(text.slice(start, i + 1));
				} catch {
					// Not JSON after all; keep scanning from the next brace.
				}
				break;
			}
		}
	}
}

function validate(raw: unknown): Face | null {
	if (typeof raw !== "object" || raw === null) return null;
	const o = raw as Record<string, unknown>;
	const hue = typeof o.hue === "number" && Number.isFinite(o.hue) ? ((o.hue % 360) + 360) % 360 : null;
	if (hue === null) return null;
	for (const key of ["body", "eyes", "mouth", "hat", "marks", "pattern"] as const) {
		if (!FACE_PARTS[key].includes(o[key] as never)) return null;
	}
	return {
		v: 1,
		hue,
		body: o.body as FaceBody,
		eyes: o.eyes as FaceEyes,
		mouth: o.mouth as FaceMouth,
		hat: o.hat as FaceHat,
		marks: o.marks as FaceMarks,
		pattern: o.pattern as FacePattern,
	};
}

/**
 * The one question a new teammate is asked. It is addressed to the agent as a
 * choice about itself, because that is the feature: the face is not assigned,
 * it is answered for.
 */
export function faceQuery(name: string, goal: string): string {
	const enums = Object.entries(FACE_PARTS)
		.map(([key, values]) => `  "${key}": one of ${values.map((v) => `"${v}"`).join(" | ")}`)
		.join("\n");
	return [
		`You are ${name}, a new teammate in Toad.${goal ? ` Your persona: ${goal}` : ""}`,
		"",
		"Before anything else, choose your own face — the icon that will represent you in the roster, permanently. Pick the parts that feel like you, not the safest ones.",
		"",
		"Answer with ONLY one JSON object, no prose, in exactly this shape:",
		"{",
		`  "v": 1,`,
		`  "hue": a number 0-359 (your color; 10-40 is reserved for errors and will be reassigned),`,
		enums,
		"}",
	].join("\n");
}

/**
 * The model-free composer: a deterministic trait reader over the persona
 * text, used when the agent cannot be asked or answers garbage. Same text,
 * same face — so a fallback face is still derived from who they are, and
 * stable across retries.
 */
export function composeFallbackFace(name: string, goal: string): Face {
	const text = `${name}\n${goal}`;
	const scores = readTraits(text);
	const rnd = mulberry(fnv(text || "toad"));
	const pick = <T>(a: readonly T[]): T => a[Math.floor(rnd() * a.length)]!;
	const ranked = Object.entries(scores)
		.filter(([, n]) => n > 0)
		.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
		.map(([k]) => k as keyof typeof TRAIT_FACE);
	const primary = ranked[0] ? TRAIT_FACE[ranked[0]] : undefined;
	const secondary = ranked[1] ? TRAIT_FACE[ranked[1]] : primary;
	if (!primary || !secondary) {
		// Nothing read: a seeded draw, so even a blank persona is stable.
		return curateFace({
			v: 1,
			hue: pick(FACE_HUES),
			body: pick(FACE_PARTS.body),
			eyes: pick(FACE_PARTS.eyes),
			mouth: pick(FACE_PARTS.mouth),
			hat: pick(FACE_PARTS.hat),
			marks: pick(FACE_PARTS.marks),
			pattern: pick(FACE_PARTS.pattern),
		});
	}
	// Primary trait supplies identity (hue, body, hat, pattern); secondary
	// supplies expression (eyes, mouth, marks). The seed picks between the two
	// hues so agents sharing a lead trait are not twins.
	return curateFace({
		v: 1,
		hue: pick(primary.hue),
		body: primary.body,
		hat: primary.hat,
		pattern: primary.pattern,
		eyes: secondary.eyes,
		mouth: secondary.mouth,
		marks: secondary.marks,
	});
}

const LEX: Record<string, string[]> = {
	regal: ["lead", "principal", "king", "chief", "senior", "orchestrat", "direct", "architect", "boss", "own"],
	precise: ["precis", "pixel", "perfect", "meticulous", "detail", "exact", "rigor", "spec", "correct", "clean"],
	art: ["design", "aesthetic", "art", "beaut", "craft", "visual", "ux", "ui", "typograph", "style"],
	playful: ["playful", "fun", "whims", "joke", "chaos", "quirk", "weird", "silly", "meme"],
	calm: ["calm", "patient", "steady", "thoughtful", "careful", "measured", "zen", "deliberate"],
	bold: ["bold", "brash", "fearless", "decisive", "ship", "fast", "aggressive", "relentless"],
	tech: ["backend", "system", "infra", "protocol", "network", "data", "machine", "kernel", "compiler"],
	growth: ["learn", "grow", "garden", "research", "curious", "explor", "experiment", "teach"],
	warm: ["warm", "friend", "help", "kind", "support", "mentor", "user", "care", "heart"],
};

type TraitPick = {
	hue: number[];
	body: FaceBody;
	eyes: FaceEyes;
	mouth: FaceMouth;
	hat: FaceHat;
	marks: FaceMarks;
	pattern: FacePattern;
};

const TRAIT_FACE: Record<string, TraitPick> = {
	regal: { hue: [294, 70], body: "wide", eyes: "half", mouth: "smirk", hat: "crown", marks: "none", pattern: "solid" },
	precise: { hue: [210, 252], body: "tall", eyes: "narrow", mouth: "flat", hat: "none", marks: "monocle", pattern: "solid" },
	art: { hue: [330, 294], body: "round", eyes: "wide", mouth: "smile", hat: "beret", marks: "none", pattern: "waterline" },
	playful: { hue: [70, 330], body: "squat", eyes: "wide", mouth: "open", hat: "beanie", marks: "freckles", pattern: "lilypad" },
	calm: { hue: [168, 122], body: "round", eyes: "half", mouth: "flat", hat: "halo", marks: "none", pattern: "solid" },
	bold: { hue: [70, 122], body: "wide", eyes: "round", mouth: "smirk", hat: "none", marks: "none", pattern: "ripples" },
	tech: { hue: [210, 252], body: "squat", eyes: "round", mouth: "none", hat: "antenna", marks: "none", pattern: "solid" },
	growth: { hue: [122, 168], body: "round", eyes: "round", mouth: "smile", hat: "sprout", marks: "none", pattern: "waterline" },
	warm: { hue: [70, 168], body: "round", eyes: "round", mouth: "smile", hat: "none", marks: "freckles", pattern: "solid" },
};

function readTraits(text: string): Record<string, number> {
	const t = text.toLowerCase();
	const scores: Record<string, number> = {};
	for (const [trait, words] of Object.entries(LEX)) {
		let n = 0;
		for (const w of words) {
			let i = -1;
			while ((i = t.indexOf(w, i + 1)) !== -1) n++;
		}
		scores[trait] = n;
	}
	return scores;
}

function fnv(s: string): number {
	let h = 2166136261;
	for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
	return h >>> 0;
}

function mulberry(seed: number): () => number {
	return () => {
		seed = (seed + 0x6d2b79f5) | 0;
		let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}
