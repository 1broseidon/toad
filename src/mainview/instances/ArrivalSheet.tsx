import { RoomBadge } from "../components/RoomBadge";

/**
 * The moment you land in a room, said out loud — once.
 *
 * Joining used to be silent: the scan succeeded and the app dropped you on a
 * roster, which is the one moment it could have taught the whole model and
 * instead said nothing (B2). Everything a person needs to understand about
 * this app is true right then — the room is the world, it has more than one
 * computer in it, and the app picks between them by itself — and it is never
 * again this cheap to say, because the roster in front of them is the proof.
 *
 * Once per room, not once per join. Re-scanning an invite to come back after
 * leaving is not an arrival, and a phone that gets this sheet every time is a
 * phone that has learned to dismiss it without reading.
 */

const SEEN_KEY = "toad.seenRooms";

function seenRooms(): string[] {
	try {
		const parsed = JSON.parse(localStorage.getItem(SEEN_KEY) ?? "[]") as unknown;
		return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
	} catch {
		return [];
	}
}

/**
 * Records the arrival and answers whether it was the first one.
 *
 * Writing before showing rather than after dismissing: a phone killed with
 * the sheet up has still been in the room, and the greeting is worth less
 * than the risk of it becoming a thing that reappears.
 */
export function markRoomArrived(roomId: string): boolean {
	const seen = seenRooms();
	if (seen.includes(roomId)) return false;
	try {
		localStorage.setItem(SEEN_KEY, JSON.stringify([...seen, roomId]));
	} catch {
		/* Private mode: the greeting may come again. Cheaper than not greeting. */
	}
	return true;
}

export type Arrival = {
	roomId: string;
	roomName: string;
	desks: number;
	/** The desk that answered the join — the app's first choice, not a setting. */
	gateway: string;
};

export function ArrivalSheet({ arrival, onDismiss }: { arrival: Arrival; onDismiss(): void }) {
	return (
		/* The same sheet grammar as every other overlay here — ConfirmSheet's
		 * holder, scrim and panel — so arriving reads as part of the app rather
		 * than as an announcement bolted over it. */
		<div className="sheet-holder" role="dialog" aria-label={`You're in ${arrival.roomName}`}>
			<button
				type="button"
				className="sheet-scrim animate-fade-in"
				aria-label="Meet the team"
				onClick={onDismiss}
			/>
			<section className="sheet-panel">
				<div className="sheet-grab" aria-hidden="true" />
				<header className="px-gutter pb-sm pt-3xs text-center">
					<div className="mb-xs flex justify-center">
						<RoomBadge roomId={arrival.roomId} name={arrival.roomName} size="lg" />
					</div>
					<h2 className="font-display text-lg font-semibold">You're in {arrival.roomName}</h2>
					<p className="mt-3xs text-sm text-ink-3">
						{arrival.desks} desktop{arrival.desks === 1 ? "" : "s"} share this team. The app stays
						connected through whichever one answers fastest — right now that's {arrival.gateway}.
					</p>
				</header>
				<div className="flex flex-col gap-xs px-gutter pb-sm">
					<button type="button" className="btn-primary w-full" onClick={onDismiss}>
						Meet the team
					</button>
				</div>
			</section>
		</div>
	);
}
