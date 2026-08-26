import { useState } from "react";
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
	/** A manually pinned desktop, or null when the phone routes itself. */
	pinned: string | null;
	/** Return to Auto: keep the current hub, but let the phone walk when it fails. */
	onAuto(): void;
	onPick(id: string): void;
	onLink(): void;
	onManage(): void;
	onClose(): void;
	/**
	 * Introduces the active desktop to another one this phone knows — the
	 * phone officiating the handshake, since it is the one thing both
	 * desktops already trust. Resolves with the outcome to show inline.
	 */
	onJoinFleet?(other: LinkedInstance): Promise<{ ok: boolean; error?: string }>;
};

export function DesktopsSheet({
	instances,
	activeId,
	wired,
	pinned,
	onAuto,
	onPick,
	onLink,
	onManage,
	onClose,
	onJoinFleet,
}: Props) {
	const others = instances.filter((instance) => instance.id !== activeId);
	const [joining, setJoining] = useState<string | null>(null);
	const [joined, setJoined] = useState<Record<string, string>>({});
	const join = async (other: LinkedInstance) => {
		if (!onJoinFleet || joining) return;
		setJoining(other.id);
		const result = await onJoinFleet(other);
		setJoined((prev) => ({
			...prev,
			[other.id]: result.ok ? "linked" : result.error ?? "failed",
		}));
		setJoining(null);
	};
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
							<button
								type="button"
								className="pset-row"
								onClick={() => {
									onAuto();
									onClose();
								}}
							>
								<span className={`pset-tile${pinned === null ? " pset-tile-tint" : ""}`}>
									<AutoGlyph />
								</span>
								<span className="pset-row-label">
									Auto
									<span className="ssub block text-xs text-ink-3">
										best available desktop — walks over if one goes quiet
									</span>
								</span>
								{pinned === null && (
									<span className="text-accent" aria-label="Routing automatically">
										<CheckGlyph />
									</span>
								)}
							</button>
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
									{(pinned === instance.id || (active && pinned === null)) && (
										<span
											className={pinned === instance.id ? "text-accent" : "text-ink-3"}
											aria-label={pinned === instance.id ? "Pinned" : "Active"}
										>
											{pinned === instance.id ? <PinGlyph /> : <CheckGlyph />}
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
					{onJoinFleet && others.length > 0 && (
						<>
							<p className="pset-label" style={{ paddingTop: 4 }}>
								Fleet
							</p>
							<div className="pset-card" style={{ background: "var(--color-paper-3)" }}>
								{others.map((other) => (
									<button
										key={other.id}
										type="button"
										className="pset-row"
										onClick={() => void join(other)}
									>
										<span className="pset-tile">
											<JoinGlyph />
										</span>
										<span className="pset-row-label">
											Join with {other.name || hostOf(other.origin)}
											<span className="block text-xs text-ink-3">
												{joining === other.id
													? "introducing…"
													: joined[other.id] ??
														"their teammates appear in this room, and yours in theirs"}
											</span>
										</span>
									</button>
								))}
							</div>
						</>
					)}
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
const JoinGlyph = () => (
	<svg {...glyph}>
		<circle cx="7" cy="12" r="3.6" />
		<circle cx="17" cy="12" r="3.6" />
		<path d="M10.6 12h2.8" />
	</svg>
);
const AutoGlyph = () => (
	<svg {...glyph}>
		<path d="M4 16.5 12 4l8 12.5" />
		<path d="M7 11.5h10" />
	</svg>
);
const PinGlyph = () => (
	<svg {...glyph}>
		<path d="M9 4h6l-1 6 3.5 3.5h-11L11 10z" />
		<path d="M12 13.5V20" />
	</svg>
);
const CheckGlyph = () => (
	<svg {...glyph} strokeWidth={2.6}>
		<path d="m4.5 12.5 5 5 10-11" />
	</svg>
);
