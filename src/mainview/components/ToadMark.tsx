/**
 * The mark: two eyes on a body, cut off by the waterline it sits in.
 *
 * One colour and one shape, in the same box `Glyph` animates in — so the still
 * stamp in the corner of the window and the teammate that hops are the same
 * drawing at two sizes, and the pupils are punched through rather than painted
 * so there is never a second fill to keep in step.
 *
 * Decorative by default. It takes a label only where it is the only thing
 * naming the app on screen; beside a title that already says Toad, a second
 * announcement of the same word is noise.
 */
export function ToadMark({ className, label }: { className?: string; label?: string }) {
	return (
		<svg
			className={className}
			viewBox="4 15 56 34"
			width="20"
			height="10"
			role={label ? "img" : undefined}
			aria-label={label}
			aria-hidden={label ? undefined : true}
			focusable="false"
		>
			<mask id="toad-mark-pupils" maskUnits="userSpaceOnUse" x="0" y="0" width="64" height="64">
				<rect width="64" height="64" fill="#fff" />
				<rect x="14.5" y="28" width="11" height="4" rx="2" fill="#000" />
				<rect x="38.5" y="28" width="11" height="4" rx="2" fill="#000" />
			</mask>
			<g mask="url(#toad-mark-pupils)" fill="currentColor">
				<rect x="4" y="30" width="56" height="18" rx="6" />
				<circle cx="20" cy="30" r="10.5" />
				<circle cx="44" cy="30" r="10.5" />
			</g>
		</svg>
	);
}
