import { useRef, useState } from "react";
import { CloseIcon } from "./icons";

/**
 * A long-pressed message's sheet: react, reply, copy.
 *
 * The quick row is the handful everyone reaches for; the keyboard button
 * opens a one-character field, which is how the platform's own emoji list
 * gets to be the picker — iOS has no system emoji panel an app can summon,
 * but every keyboard carries one.
 */

const QUICK = ["👍", "❤️", "😂", "🎉", "👀", "🙏"];

type Props = {
	/** The speaker, for the header: the teammate's name, or "you". */
	speaker: string;
	text: string;
	onReact(emoji: string): void;
	onReply(): void;
	onCopy(): void;
	onClose(): void;
};

export function BubbleSheet({ speaker, text, onReact, onReply, onCopy, onClose }: Props) {
	const [typing, setTyping] = useState(false);
	const field = useRef<HTMLInputElement>(null);

	const react = (raw: string) => {
		// The first grapheme, so a fast double-tap on the emoji keyboard or a
		// composed sequence (👩‍💻) still lands as one mark.
		const segmenter = new Intl.Segmenter();
		const first = segmenter.segment(raw)[Symbol.iterator]().next();
		if (!first.done) onReact(first.value.segment);
		onClose();
	};

	return (
		<div className="sheet-holder" role="dialog" aria-label="Message actions">
			<button type="button" className="sheet-scrim animate-fade-in" aria-label="Close" onClick={onClose} />
			<section className="sheet-panel">
				<div className="sheet-grab" aria-hidden="true" />
				<header className="flex items-baseline gap-xs px-gutter pb-2xs">
					<h2 className="shrink-0 text-sm font-medium text-ink-2">{speaker}</h2>
					<p className="min-w-0 flex-1 truncate text-sm text-ink-3">{text}</p>
					<button type="button" className="btn-ghost !px-xs" aria-label="Close" onClick={onClose}>
						<CloseIcon />
					</button>
				</header>

				<div className="reaction-row px-gutter">
					{QUICK.map((mark) => (
						<button
							key={mark}
							type="button"
							className="reaction-quick"
							aria-label={`React ${mark}`}
							onClick={() => react(mark)}
						>
							{mark}
						</button>
					))}
					{typing ? (
						<input
							ref={field}
							className="reaction-any field"
							aria-label="Any emoji"
							placeholder="?"
							autoFocus
							inputMode="text"
							onChange={(event) => {
								const value = event.currentTarget.value.trim();
								if (value) react(value);
							}}
						/>
					) : (
						<button
							type="button"
							className="reaction-quick reaction-more"
							aria-label="Any emoji from the keyboard"
							onClick={() => setTyping(true)}
						>
							⌨
						</button>
					)}
				</div>

				<div className="px-gutter pb-sm pt-2xs">
					<button type="button" className="sheet-action" onClick={() => { onReply(); onClose(); }}>
						Reply
					</button>
					<button type="button" className="sheet-action" onClick={() => { onCopy(); onClose(); }}>
						Copy Message
					</button>
				</div>
			</section>
		</div>
	);
}
