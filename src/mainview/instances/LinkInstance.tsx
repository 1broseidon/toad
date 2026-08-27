import { useEffect, useRef, useState } from "react";
import { joinAsNode, type JoinedRoom } from "../node-join";
import { originFromAddress, originFromPairUrl, scanPhoto, startViewfinder } from "../qr-scan";
import { claimPairing } from "../pair";
import { hostOf } from "./marks";
import type { LinkedInstance, PairedInstance } from "./store";

/**
 * Linking a desktop.
 *
 * The QR the desktop shows carries both halves of the answer — the one-time
 * code and where to spend it — so the camera is the whole flow when it
 * works. It does not always work: a WebView can be refused the camera, and
 * there is no camera at all in a browser running the screens. So the same
 * two facts can be typed, and the address is remembered from the QR when
 * one was read.
 *
 * The pairing is claimed against the plain http door, never the https one:
 * the desktop's certificate is self-signed and a native client has no way
 * to be persuaded of it.
 */

type Props = {
	/** The row this is re-linking, whose address is the likely one. */
	relinking?: LinkedInstance;
	onLinked(paired: PairedInstance): void;
	/** The desk answered as a plane admission: the whole granted room. */
	onJoined(room: JoinedRoom): void;
	onCancel(): void;
};

/** What the camera is doing, which decides what is on screen under it. */
type Camera = "starting" | "live" | "photo";

export function LinkInstance({ relinking, onLinked, onJoined, onCancel }: Props) {
	const [address, setAddress] = useState(relinking ? hostOf(relinking.origin) : "");
	const [code, setCode] = useState("");
	const [camera, setCamera] = useState<Camera>("starting");
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);

	const video = useRef<HTMLVideoElement>(null);
	const file = useRef<HTMLInputElement>(null);
	/* The claim outlives this screen if it is closed mid-flight, and a
	 * viewfinder that outlives it holds the camera light on. */
	const alive = useRef(true);
	/* The viewfinder's callback is made once, at mount. A QR that carries no
	 * address falls back to the typed one, and that has to be whatever is in
	 * the field now rather than whatever was in it then. */
	const typed = useRef(address);
	typed.current = address;

	const claim = async (pairCode: string, origin: string | null) => {
		const target = origin ?? originFromAddress(typed.current);
		if (!target) {
			setError("Type the desktop's address — the one under the code on screen.");
			return;
		}
		if (!pairCode) {
			setError("Type the code first.");
			return;
		}
		setError("");
		setBusy(true);
		/* Membership first: one identity for the whole room, and the desk
		 * answers with every granted desktop at once. A desk too old to know
		 * the join still speaks the pairing below, and nothing is lost by
		 * having asked. */
		const joined = await joinAsNode(pairCode, target);
		if (!alive.current) return;
		if (joined.ok) {
			setBusy(false);
			onJoined(joined);
			return;
		}
		if (!joined.unsupported && !joined.unreachable) {
			/* A readable refusal came from a current desk — a spent code, a
			 * revoked membership. Falling back would quietly downgrade a desk
			 * that just said no. */
			setBusy(false);
			setError(joined.error || "That code didn't work — codes expire after two minutes.");
			return;
		}
		/* Old desk or dead desk — from the native origin the join cannot tell
		 * (no CORS on old answers), so the legacy claim settles it: every
		 * build answers /pair with CORS, and a desk that refuses that too is
		 * genuinely out of reach. */
		const paired = await claimPairing(pairCode, target);
		if (!alive.current) return;
		setBusy(false);
		if (!paired) {
			setError(
				joined.unreachable
					? "Could not reach that desktop — check it is on and on this network."
					: "That code didn't work — codes expire after two minutes.",
			);
			return;
		}
		onLinked({
			/* An older desktop does not name itself. Its address stands in, so a
			 * link made against one still lands in a row of its own — and the
			 * port is left out, because a port change is not a new machine. */
			id: paired.instanceId ?? `origin:${hostOf(target)}`,
			name: paired.hostName || hostOf(target),
			origin: target,
			token: paired.token,
			deviceId: paired.deviceId,
		});
	};

	const onPayload = (pairCode: string, payload: string) => {
		const read = originFromPairUrl(payload);
		const origin = read?.origin ?? null;
		// Shown as well as used: the address is what the typed path needs if
		// the claim fails and the code has to be entered by hand.
		if (origin) setAddress(hostOf(origin));
		setCode(pairCode);
		void claim(pairCode, origin);
	};

	// The camera opens itself: pointing the phone at the screen is the whole
	// interaction, and a button in front of it is one tap of nothing.
	useEffect(() => {
		alive.current = true;
		const element = video.current;
		if (!element) return;
		let stop: (() => void) | null = null;
		void startViewfinder(element, onPayload).then(
			(release) => {
				if (!alive.current) release();
				else {
					stop = release;
					setCamera("live");
				}
			},
			() => {
				// Denied, or an insecure origin, or no camera in this browser at
				// all. A photo of the same QR decodes just as well.
				if (alive.current) setCamera("photo");
			},
		);
		return () => {
			alive.current = false;
			stop?.();
		};
	}, []);

	return (
		/* Fixed title over a scrolling body, as on the roster: scrolling the whole
		   screen would slide the heading up behind the status bar. */
		<div className="flex h-full w-full flex-col bg-paper">
			<header className="safe-head px-gutter pb-lg">
				<h1 className="font-display text-2xl tracking-display text-ink">Link a desktop</h1>
				<p className="mt-2xs text-md leading-relaxed text-ink-3">
					On the desktop, open Settings → General → Web access and press “Add device”.
				</p>
			</header>

			<div className="flex min-h-0 flex-1 flex-col items-center gap-sm overflow-y-auto px-gutter">
				<video
					ref={video}
					playsInline
					muted
					className="rounded-lg border border-rule bg-paper-2 object-cover"
					/* Wide rather than square: the QR only needs the middle, and a
					   square viewfinder pushed the fields and the Link button below
					   the fold of every phone. */
					style={{ width: "min(88vw, 22rem)", aspectRatio: "8 / 5" }}
					/* Kept in the layout while the camera is starting: `display:
					   none` is a reason iOS will refuse to play a stream at all,
					   and an empty box for a beat is cheaper than that. */
					hidden={camera === "photo"}
				/>

				{camera === "photo" && (
					<>
						<button type="button" className="btn-outline" onClick={() => file.current?.click()}>
							Take a photo of the code
						</button>
						<input
							ref={file}
							type="file"
							accept="image/*"
							capture="environment"
							hidden
							onChange={(event) => {
								const photo = event.currentTarget.files?.[0];
								event.currentTarget.value = "";
								if (!photo) return;
								setError("");
								void scanPhoto(photo).then(
									(payload) => {
										const read = payload === null ? null : originFromPairUrl(payload);
										if (read && payload !== null) onPayload(read.code, payload);
										else setError("No QR in that shot — get the whole code in frame.");
									},
									() => setError("Could not read that photo — type the code instead."),
								);
							}}
						/>
					</>
				)}

				<div className="w-full">
					<label className="label" htmlFor="link-address">
						Desktop address
					</label>
					<input
						id="link-address"
						className="field font-mono text-md"
						placeholder="192.168.1.20"
						inputMode="url"
						autoCapitalize="none"
						autoCorrect="off"
						spellCheck={false}
						value={address}
						onChange={(event) => setAddress(event.target.value)}
					/>

					<label className="label mt-md" htmlFor="link-code">
						Code
					</label>
					<input
						id="link-code"
						className="field font-mono tracking-wide"
						autoComplete="one-time-code"
						inputMode="text"
						autoCapitalize="none"
						spellCheck={false}
						placeholder="code"
						value={code}
						onChange={(event) => setCode(event.target.value)}
						onKeyDown={(event) => {
							if (event.key === "Enter") void claim(code.trim(), null);
						}}
					/>

					<button
						type="button"
						className="btn-primary mt-md w-full"
						disabled={busy}
						onClick={() => void claim(code.trim(), null)}
					>
						{busy ? "Linking…" : "Link"}
					</button>

					{/* Held open, so an error does not shove the fields up the screen. */}
					<p className="mt-sm min-h-6 text-sm text-danger">{error}</p>
				</div>
			</div>

			<footer className="safe-foot px-gutter pt-md">
				<button type="button" className="btn-ghost w-full" onClick={onCancel}>
					Cancel
				</button>
			</footer>
		</div>
	);
}
