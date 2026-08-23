import { useEffect, useRef, useState } from "react";
import type { ComputerStatus, Persona } from "../../shared/types";
import { api } from "../rpc";
import { Toolbar } from "./Toolbar";
import { CloseIcon } from "./icons";

/**
 * The right drawer behind the computer icon: what the teammate's machine
 * looks like right now, and the door to driving it.
 *
 * A glance must never be the thing that wakes the machine — status and
 * screenshot are read-only against whatever state the container is in, and
 * an asleep computer shows as asleep. Connecting to the screen is the one
 * deliberate act that wakes it, because clicking "open the screen" is the
 * user saying they want the machine on.
 */

type Props = {
	persona: Persona;
	/** Open straight onto the live screen — the hand-to-human card's path. */
	initialScreen?: boolean;
	onClose(): void;
};

const REFRESH_MS = 5_000;

const STATE_COPY: Record<ComputerStatus["state"], { label: string; hint: string }> = {
	running: { label: "running", hint: "Awake and holding its tools." },
	stopped: {
		label: "asleep",
		hint: "Stopped to free CPU and RAM. Everything installed is still there; it wakes on the next tool call — or when you open the screen.",
	},
	absent: {
		label: "hibernated",
		hint: "No container right now. The next wake builds a fresh machine and runs the provision script from the workspace.",
	},
};

function relative(ts: number | undefined): string {
	if (!ts) return "never";
	const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
	if (s < 60) return "just now";
	if (s < 3600) return `${Math.round(s / 60)}m ago`;
	if (s < 86400) return `${Math.round(s / 3600)}h ago`;
	return `${Math.round(s / 86400)}d ago`;
}

export function ComputerDrawer({ persona, initialScreen, onClose }: Props) {
	const [status, setStatus] = useState<ComputerStatus | null>(null);
	const [shot, setShot] = useState<string | null>(null);
	const [screen, setScreen] = useState(initialScreen ?? false);
	const [frames, setFrames] = useState<Array<{ ts: number; dataUrl: string }>>([]);
	const [viewing, setViewing] = useState<{ ts: number; dataUrl: string } | null>(null);

	useEffect(() => {
		let alive = true;
		const refresh = async () => {
			const next = await api.computerStatus(persona.id).catch(() => null);
			if (!alive || !next) return;
			setStatus(next);
			// Frames outlive the machine state: a stopped desktop still shows
			// what its hands did last, which is the audit the strip exists for.
			const recent = await api.computerFrames(persona.id).catch(() => ({ frames: [] }));
			if (alive) setFrames(recent.frames);
			if (next.state === "running") {
				const { dataUrl } = await api.computerScreenshot(persona.id).catch(() => ({ dataUrl: null }));
				if (alive && dataUrl) setShot(dataUrl);
			}
		};
		void refresh();
		const timer = setInterval(() => void refresh(), REFRESH_MS);
		return () => {
			alive = false;
			clearInterval(timer);
		};
	}, [persona.id]);

	const state = status ? STATE_COPY[status.state] : null;

	return (
		<div
			className="absolute inset-x-0 bottom-0 top-toolbar z-overlay flex justify-end"
			role="dialog"
			aria-modal="true"
		>
			<button
				type="button"
				className="sheet-scrim animate-fade-in"
				aria-label="Close computer"
				onClick={onClose}
			/>
			<section className="pane-drawer relative z-raised flex h-full w-full max-w-composer flex-col bg-paper shadow-float animate-slide-in-right">
				<Toolbar as="header" className="gap-xs border-b border-rule px-gutter">
					<h2 className="min-w-0 flex-1 truncate text-sm font-medium text-ink">
						{persona.name}'s computer
					</h2>
					<button
						autoFocus
						type="button"
						className="btn-ghost !px-xs"
						aria-label="Close computer"
						title="Close"
						onClick={onClose}
					>
						<CloseIcon />
					</button>
				</Toolbar>

				<div className="flex flex-col gap-md overflow-y-auto p-gutter">
					{/* The screen, or where it will be. Clicking it opens control. */}
					{status?.state === "running" && shot ? (
						<button
							type="button"
							className="group relative block w-full overflow-hidden rounded-md border border-rule bg-black text-left"
							title="Open the screen"
							onClick={() => setScreen(true)}
						>
							<img src={shot} alt="The computer's desktop" className="block w-full" />
							<span className="absolute inset-0 flex items-end justify-center bg-transparent pb-sm opacity-0 transition-opacity group-hover:opacity-100">
								<span className="rounded-pill bg-paper/90 px-sm py-2xs text-xs text-ink shadow-float">
									Open the screen
								</span>
							</span>
						</button>
					) : (
						<button
							type="button"
							className="flex aspect-video w-full flex-col items-center justify-center gap-2xs rounded-md border border-dashed border-rule-strong text-ink-3 hover:text-ink-2"
							title="Open the screen (wakes the computer)"
							onClick={() => setScreen(true)}
						>
							<span className="text-sm">{state ? state.label : "checking…"}</span>
							<span className="text-2xs">click to wake and open the screen</span>
						</button>
					)}

					{/* The filmstrip: recent captures, newest first. This is where the
					    work gets audited — the chat carries the words, this carries
					    what the screen looked like while they happened. */}
					{frames.length > 0 && (
						<div className="flex flex-col gap-2xs">
							<span className="text-xs text-ink-3">Recent captures</span>
							<ul className="m-0 flex list-none gap-2xs overflow-x-auto p-0">
								{frames.map((frame) => (
									<li key={frame.ts} className="shrink-0">
										<button
											type="button"
											className="block w-28 overflow-hidden rounded-sm border border-rule bg-black"
											title={`Captured ${relative(frame.ts)}`}
											onClick={() => setViewing(frame)}
										>
											<img
												src={frame.dataUrl}
												alt={`Capture from ${relative(frame.ts)}`}
												className="block w-full"
											/>
										</button>
									</li>
								))}
							</ul>
						</div>
					)}

					{status && (
						<>
							<div className="flex items-center gap-xs text-sm">
								<span
									className={`h-dot w-dot shrink-0 rounded-pill ${
										status.state === "running" ? "bg-accent" : "border-2 border-ink-3"
									}`}
									aria-hidden="true"
								/>
								<span className="text-ink">{state?.label}</span>
							</div>
							{state && <p className="m-0 text-xs leading-relaxed text-ink-3">{state.hint}</p>}

							<dl className="m-0 flex flex-col gap-2xs text-xs text-ink-3">
								<div className="flex gap-sm">
									<dt className="w-20 shrink-0">Image</dt>
									<dd className="m-0 min-w-0 truncate font-mono text-ink-2">{status.image}</dd>
								</div>
								<div className="flex gap-sm">
									<dt className="w-20 shrink-0">Runtime</dt>
									<dd className="m-0 text-ink-2">{status.runtime ?? "none found"}</dd>
								</div>
								<div className="flex gap-sm">
									<dt className="w-20 shrink-0">Last used</dt>
									<dd className="m-0 text-ink-2">{relative(status.lastUsedAt)}</dd>
								</div>
							</dl>
						</>
					)}
				</div>
			</section>

			{/* One capture, big. A look back, not a live view — closing returns
			    to the drawer, never to the screen. */}
			{viewing && (
				<div className="absolute inset-0 z-raised flex flex-col bg-paper">
					<Toolbar as="header" className="gap-xs border-b border-rule px-gutter">
						<h2 className="min-w-0 flex-1 truncate text-sm font-medium text-ink">
							Captured {relative(viewing.ts)}
						</h2>
						<button
							type="button"
							className="btn-ghost !px-xs"
							aria-label="Close capture"
							title="Back to the computer"
							onClick={() => setViewing(null)}
						>
							<CloseIcon />
						</button>
					</Toolbar>
					<div className="flex min-h-0 flex-1 items-center justify-center bg-black">
						<img
							src={viewing.dataUrl}
							alt="An enlarged capture"
							className="max-h-full max-w-full object-contain"
						/>
					</div>
				</div>
			)}

			{screen && <ComputerScreen persona={persona} onClose={() => setScreen(false)} />}
		</div>
	);
}

/**
 * The full pane: a live VNC session over the proxy's WebSocket. Mounting
 * connects (and wakes the machine if it was asleep); unmounting hangs up.
 */
function ComputerScreen({ persona, onClose }: Props) {
	const mount = useRef<HTMLDivElement | null>(null);
	const [phase, setPhase] = useState<"connecting" | "connected" | "failed">("connecting");

	useEffect(() => {
		let rfb: import("@novnc/novnc").default | null = null;
		let alive = true;
		void (async () => {
			try {
				const [{ url }, { default: RFB }] = await Promise.all([
					api.computerVncUrl(persona.id),
					import("@novnc/novnc"),
				]);
				if (!alive || !mount.current) return;
				rfb = new RFB(mount.current, url);
				rfb.scaleViewport = true;
				rfb.background = "transparent";
				rfb.addEventListener("connect", () => alive && setPhase("connected"));
				rfb.addEventListener("disconnect", () => alive && setPhase("failed"));
			} catch {
				if (alive) setPhase("failed");
			}
		})();
		return () => {
			alive = false;
			try {
				rfb?.disconnect();
			} catch {}
		};
	}, [persona.id]);

	return (
		<div className="absolute inset-0 z-raised flex flex-col bg-paper">
			<Toolbar as="header" className="gap-xs border-b border-rule px-gutter">
				<h2 className="min-w-0 flex-1 truncate text-sm font-medium text-ink">
					{persona.name}'s screen
					{phase === "connecting" && <span className="text-ink-3"> — connecting…</span>}
					{phase === "failed" && <span className="text-ink-3"> — connection lost</span>}
				</h2>
				<button
					type="button"
					className="btn-ghost !px-xs"
					aria-label="Close screen"
					title="Back to the computer"
					onClick={onClose}
				>
					<CloseIcon />
				</button>
			</Toolbar>
			{/* noVNC owns this box. It sizes the canvas to fill it and scales the
			    remote desktop down to fit. */}
			<div ref={mount} className="min-h-0 flex-1 bg-black" />
		</div>
	);
}
