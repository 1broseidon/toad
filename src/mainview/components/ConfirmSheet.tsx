/**
 * The phone's destructive ask.
 *
 * The desktop hands this question to the system's message box. Over a wire
 * there is no one at that desk to answer it — the question has to travel to
 * the thumb that asked, as the same sheet every other overlay here arrives in.
 */

type Props = {
	title: string;
	detail: string;
	/** The destructive act, named — "Remove Nancy", never "OK". */
	action: string;
	onConfirm(): void;
	onClose(): void;
};

export function ConfirmSheet({ title, detail, action, onConfirm, onClose }: Props) {
	return (
		<div className="sheet-holder" role="alertdialog" aria-label={title}>
			<button
				type="button"
				className="sheet-scrim animate-fade-in"
				aria-label="Cancel"
				onClick={onClose}
			/>
			<section className="sheet-panel">
				<div className="sheet-grab" aria-hidden="true" />
				<header className="px-gutter pb-sm pt-3xs text-center">
					<h2 className="font-display text-lg font-semibold">{title}</h2>
					<p className="mt-3xs text-sm text-ink-3">{detail}</p>
				</header>
				<div className="flex flex-col gap-xs px-gutter pb-sm">
					<button
						type="button"
						className="confirm-destroy"
						onClick={() => {
							onConfirm();
							onClose();
						}}
					>
						{action}
					</button>
					<button type="button" className="confirm-cancel" onClick={onClose}>
						Cancel
					</button>
				</div>
			</section>
		</div>
	);
}
