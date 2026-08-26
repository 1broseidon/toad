import { useEffect, useState } from "react";
import type { LinkedInstance } from "./store";
import { hostOf } from "./marks";
import { api } from "../rpc";

/**
 * The pill's answer, simplified to what a person actually decides.
 *
 * Routing is not one of those things: the phone rides the best available
 * desktop and walks over on its own when one goes quiet, so this sheet
 * shows one status line — where you are connected — and no switcher. The
 * two real actions are linking a new desktop and the Manage screen, which
 * is where deliberate switching lives for the rare day it is wanted.
 *
 * The one conditional act: introducing two desktops that both trust this
 * phone but have not met each other. The row exists only while that is
 * true, and disappears once the room is whole.
 */

type Props = {
	instances: LinkedInstance[];
	activeId: string | null;
	/** The wire's state, for the status line. */
	wired: boolean;
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

export function DesktopsSheet({ instances, activeId, wired, onLink, onManage, onClose, onJoinFleet }: Props) {
	const active = instances.find((instance) => instance.id === activeId) ?? null;
	const others = instances.filter(
		(instance) => instance.id !== activeId && instance.state === "linked",
	);

	/* Which of the other desktops the active one already knows. Read when the
	 * sheet opens; until it answers, no introduction is offered — a row that
	 * appears is better than one that flashes away. */
	const [met, setMet] = useState<Set<string> | null>(null);
	useEffect(() => {
		let cancelled = false;
		void api.fleetPeers().then(
			(peers) => {
				if (!cancelled) setMet(new Set(peers.map((peer) => peer.id)));
			},
			() => {
				if (!cancelled) setMet(new Set());
			},
		);
		return () => {
			cancelled = true;
		};
	}, []);
	const strangers = met === null ? [] : others.filter((other) => !met.has(other.id));

	const [joining, setJoining] = useState<string | null>(null);
	const [joined, setJoined] = useState<Record<string, string>>({});
	const join = async (other: LinkedInstance) => {
		if (!onJoinFleet || joining) return;
		setJoining(other.id);
		const result = await onJoinFleet(other);
		setJoined((prev) => ({
			...prev,
			[other.id]: result.ok ? "linked — one room now" : result.error ?? "failed",
		}));
		setJoining(null);
		if (result.ok) setMet((prev) => new Set([...(prev ?? []), other.id]));
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
						<div className="pset-row">
							<span className="pset-tile pset-tile-tint">
								<DesktopGlyph />
							</span>
							<span className="pset-row-label">
								{active ? active.name || hostOf(active.origin) : "No desktop"}
								<span className="ssub block text-xs text-ink-3">
									{active
										? wired
											? others.length > 0
												? "connected — switches on its own if this one goes quiet"
												: "connected"
											: "looking for it…"
										: "link one below"}
								</span>
							</span>
						</div>
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
					{onJoinFleet && strangers.length > 0 && (
						<div className="pset-card" style={{ background: "var(--color-paper-3)" }}>
							{strangers.map((other) => (
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
										Introduce {other.name || hostOf(other.origin)}
										<span className="block text-xs text-ink-3">
											{joining === other.id
												? "introducing…"
												: joined[other.id] ??
													"your desktops haven't met — link them into one room"}
										</span>
									</span>
								</button>
							))}
						</div>
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
