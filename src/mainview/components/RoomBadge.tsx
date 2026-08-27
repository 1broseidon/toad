import type { CSSProperties } from "react";

/**
 * A room, drawn.
 *
 * The room is the app's most important object and the only one that recurs on
 * every screen — the Rooms list, the room screen's header, the sheet that
 * greets you on arrival. It needs to be recognisable before it is read, so it
 * gets a stamp rather than a generic icon: a monogram on a rounded square,
 * washed in a hue derived from the room's id.
 *
 * Derived, not stored, and derived from the *id* rather than the name: the
 * same room is the same colour on every phone and every desktop that ever
 * draws it, with nothing to sync and nothing to migrate, and renaming a room
 * does not recolour it out from under the person who learned it.
 *
 * A face would be wrong here for the reason `marks.ts` gives about desktops —
 * faces in this app belong to teammates, who chose them.
 */

/**
 * The moss band, in degrees, kept clear of room hues.
 *
 * Moss is the app's health colour: the live dot, the "your connection"
 * caption, the accent on a switch that is on. A room badge that landed in
 * that band would read as a *status* rather than as an identity — a green
 * room would look like a healthy one, and the same room would look healthy
 * on the screen that is telling you it has gone quiet. So the wheel the hash
 * lands on is 360° with this band cut out of it, and hues at or above the
 * floor are pushed past the ceiling.
 */
const MOSS_FROM = 122;
const MOSS_TO = 162;
const WHEEL = 360 - (MOSS_TO - MOSS_FROM);

/**
 * FNV-1a over the id — a hash chosen for being short, stable, and identical
 * in every language something might redraw this badge in. `Math.imul` keeps
 * the multiply in 32 bits, which is the whole trick to matching other
 * implementations.
 */
export function roomHue(roomId: string): number {
	let hash = 0x811c9dc5;
	for (let index = 0; index < roomId.length; index += 1) {
		hash ^= roomId.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193);
	}
	const landed = (hash >>> 0) % WHEEL;
	return landed < MOSS_FROM ? landed : landed + (MOSS_TO - MOSS_FROM);
}

/**
 * The first letter of the first two words: "Toad Room" is TR, "Acme" is A.
 *
 * Split on anything that is not a letter or a digit so that "work-room" and
 * "Toad  Room" read the same, and take code points rather than UTF-16 units so
 * a name that opens with an emoji or an astral character is not cut in half.
 *
 * Apostrophes are the exception, held inside the word rather than splitting
 * it: "George's Fleet" is two words to a reader and must be GF, not the GS a
 * plain non-alphanumeric split gives by treating the trailing "s" as a word of
 * its own. Fragments left holding no letter or digit at all are dropped, so a
 * name that is punctuation around one word still monograms from the word.
 */
export function roomMonogram(name: string): string {
	const words = name.split(/[^\p{L}\p{N}'’]+/u).filter((word) => /[\p{L}\p{N}]/u.test(word));
	const letters = words.slice(0, 2).map((word) => [...word][0] ?? "");
	return letters.join("").toUpperCase() || "?";
}

/**
 * `sm` (34px) sits in a settings row; `lg` (44px) leads a screen header or a
 * sheet. Two sizes on purpose — a badge that scales freely stops being a
 * stamp and starts being a picture.
 */
export function RoomBadge({
	roomId,
	name,
	size = "sm",
	className,
}: {
	roomId: string;
	name: string;
	size?: "sm" | "lg";
	className?: string;
}) {
	/* Decorative: the name it stands for is always beside it, and a screen
	 * reader that announced "T R" first would be reading the abbreviation
	 * before the word it abbreviates. */
	return (
		<span
			aria-hidden="true"
			className={`room-badge${className ? ` ${className}` : ""}`}
			data-size={size}
			style={{ "--room-hue": roomHue(roomId) } as CSSProperties}
		>
			{roomMonogram(name)}
		</span>
	);
}
