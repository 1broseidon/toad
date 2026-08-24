import type { LinkedInstance } from "./store";
import { hostOf } from "./marks";
import { timeAgoShort } from "../messages";

/**
 * The pill's answer: which desktop this roster lives on, the others this
 * phone has met, and the door to pairing another.
 *
 * A half sheet, not a screen — glancing at the room you're wired into should
 * not mean leaving it. The full Instances screen stays behind "Manage" for
 * renames, forgetting, and relinking.
 */

type Props = {
	instances: LinkedInstance[];
	activeId: string | null;
	/** The wire's state, for the active row's one-word subtitle. */
	wired: boolean;
	onPick(id: string): void;
	onLink(): void;
	onManage(): void;
	onClose(): void;
};

export function DesktopsSheet({
	instances,
	activeId,
	wired,
	onPick,
	onLink,
	onManage,
	onClose,
}: Props) {
	return (
		<div className="sheet-holder" role="dialog" aria-label="Desktops">
			<button
				type="button"
				className="sheet-scrim animate-fade-in"
				aria-label="Close"
				onClick={onClose}
			/>
			<section className="sheet-panel">
				<div className="sheet-grab" aria-hidden="true" />
				<h2 className="pb-sm text-center font-display text-lg font-semibold tracking-tight">
					Desktops
				</h2>
				<div className="px-md pb-sm">
					<div className="pset-card" style={{ background: "var(--color-paper-3)" }}>
						{instances.map((instance) => {
							const active = instance.id === activeId;
							return (
								<button
									key={instance.id}
									type="button"
									className="pset-row"
									onClick={() => {
										if (!active) onPick(instance.id);
										onClose();
									}}
								>
									<span className={`pset-tile${active ? " pset-tile-tint" : ""}`}>
										<DesktopGlyph />
									</span>
									<span className="pset-row-label">
										{instance.name || hostOf(instance.origin)}
										<span className="ssub block text-xs text-ink-3">
											{active
												? wired
													? "wired now"
													: "looking for it…"
												: `seen ${timeAgoShort(instance.lastSeenAt)} ago`}
										</span>
									</span>
									{active && (
										<span className="text-accent" aria-label="Active">
											<CheckGlyph />
										</span>
									)}
								</button>
							);
						})}
					</div>
					<div className="pset-card" style={{ background: "var(--color-paper-3)" }}>
						<button
							type="button"
							className="pset-row"
							onClick={() => {
								onClose();
								onLink();
							}}
						>
							<span className="pset-tile">
								<QrGlyph />
							</span>
							<span className="pset-row-label">
								Link a desktop
								<span className="block text-xs text-ink-3">scan the QR in Toad on your Mac</span>
							</span>
						</button>
						<button
							type="button"
							className="pset-row"
							onClick={() => {
								onClose();
								onManage();
							}}
						>
							<span className="pset-tile">
								<ManageGlyph />
							</span>
							<span className="pset-row-label">Manage desktops</span>
						</button>
					</div>
				</div>
			</section>
		</div>
	);
}

const glyph = {
	width: 16,
	height: 16,
	viewBox: "0 0 24 24",
	fill: "none",
	stroke: "currentColor",
	strokeWidth: 1.9,
	strokeLinecap: "round",
	strokeLinejoin: "round",
	"aria-hidden": true,
} as const;

const DesktopGlyph = () => (
	<svg {...glyph}>
		<rect x="2.5" y="4.5" width="19" height="13" rx="2.4" />
		<path d="M9 20.5h6M12 17.5v3" />
	</svg>
);
const QrGlyph = () => (
	<svg {...glyph}>
		<rect x="3" y="3" width="7.5" height="7.5" rx="1.6" />
		<rect x="13.5" y="3" width="7.5" height="7.5" rx="1.6" />
		<rect x="3" y="13.5" width="7.5" height="7.5" rx="1.6" />
		<path d="M13.5 13.5h3.2v3.2h-3.2zM17.8 17.8H21V21h-3.2z" />
	</svg>
);
const ManageGlyph = () => (
	<svg {...glyph}>
		<path d="M4 8h16M4 16h16" />
		<circle cx="9" cy="8" r="2.2" fill="var(--color-paper-4)" />
		<circle cx="15" cy="16" r="2.2" fill="var(--color-paper-4)" />
	</svg>
);
const CheckGlyph = () => (
	<svg {...glyph} strokeWidth={2.6}>
		<path d="m4.5 12.5 5 5 10-11" />
	</svg>
);
