import { useEffect, useState } from "react";
import { ConfirmSheet } from "../components/ConfirmSheet";
import { RoomBadge } from "../components/RoomBadge";
import { ToadMark } from "../components/ToadMark";
import { BackIcon } from "../components/icons";
import { since, vitalOf } from "./marks";
import { activeRoomOf, type InstanceJar, type LinkedInstance, type RoomEntry, roomsOf } from "./store";
import type { InstanceStatus } from "./useInstances";

/**
 * The room this phone is in.
 *
 * Not a list of machines any more, and not a chooser. The room is the world:
 * it has a name, a badge, a size and a date you joined it, and the desktops
 * under it are plumbing the app manages on its own — shown so you can see the
 * room is healthy, not so you can pick one. Which desk the wire is on is a
 * caption ("your connection"), never a control.
 *
 * Three states share this screen, because they are three answers to the same
 * question — what is this phone attached to:
 *
 *   · nothing yet, which is a welcome rather than an empty manager (A1/A2);
 *   · a room, which is the screen this file is mostly about;
 *   · a legacy direct link, one desk paired before rooms existed, which keeps
 *     its own Forget flow until legacy support goes.
 *
 * "Join a room" is deliberately absent: from the screen that manages the room
 * you are in, the loudest control used to be the one that leaves for a
 * different room (E1). Joining lives in Settings → Rooms, where switching
 * context already does.
 */

type Props = {
	/** The whole jar: this screen is about how the rows group, not the rows. */
	jar: InstanceJar;
	status: InstanceStatus;
	/** Join a room, or — given a row — link that legacy desktop again. */
	onLink(instance?: LinkedInstance): void;
	/**
	 * Drop a legacy row. Revoking on the desktop is attempted first by the
	 * caller, and reports back whether it landed — an unreachable desktop still
	 * holds the device in its list.
	 */
	onForget(instance: LinkedInstance): Promise<boolean>;
	/**
	 * Leave one room: that room's member rows go at once, and no others. A
	 * member's desktop list is a grant projection, so a single row cannot be
	 * forgotten — the next connect would fold it straight back in.
	 */
	onLeaveRoom(roomKey: string): void;
	/** Back to the conversation, where there is one to go back to. */
	onClose?(): void;
};

type Ask = {
	title: string;
	detail: string;
	action: string;
	run(): void;
};

export function InstancesScreen({ jar, status, onLink, onForget, onLeaveRoom, onClose }: Props) {
	/* Destructive asks arrive as the sheet every other one does. */
	const [confirm, setConfirm] = useState<Ask | null>(null);
	const [note, setNote] = useState<string | null>(null);

	if (jar.instances.length === 0) return <Welcome onJoin={() => onLink()} />;

	/* The active room, or the first one while the jar has rows but no wire yet
	 * — a tick after a leave, before the app has walked to what is left. The
	 * screen is never drawn empty, so there is always one of these. */
	const rooms = roomsOf(jar);
	const room = activeRoomOf(jar) ?? rooms[0]!;

	return (
		<div className="flex h-full w-full flex-col bg-paper">
			<header className="safe-head flex items-start gap-sm px-gutter pb-md">
				{onClose && (
					<button
						type="button"
						className="btn-ghost -ml-2xs mt-3xs shrink-0 !px-xs"
						aria-label="Back to the conversation"
						onClick={onClose}
					>
						<BackIcon />
					</button>
				)}
				<RoomBadge roomId={room.key} name={room.name} size="lg" />
				<div className="min-w-0 pt-3xs">
					<h1 className="truncate font-display text-2xl text-ink">{room.name}</h1>
					<p className="mt-3xs text-xs text-ink-3">{subtitleOf(room)}</p>
				</div>
			</header>

			<div className="room-scroll">
				<div className="room-body">
					{room.direct ? (
						<DirectBody
							room={room}
							status={status}
							onRelink={() => onLink(room.desks[0])}
							onForget={() => {
								const desk = room.desks[0]!;
								setConfirm({
									title: `Forget ${desk.name}?`,
									detail:
										"The link is discarded on this phone. Linking again needs a new code from that desktop.",
									action: `Forget ${desk.name}`,
									run: () =>
										void onForget(desk).then((revoked) => {
											if (!revoked) setNote("Removed here. Revoke it on that desktop too.");
										}),
								});
							}}
							note={note}
						/>
					) : (
						<RoomBody
							room={room}
							activeId={jar.activeId}
							status={status}
							onLeave={() =>
								setConfirm({
									title: `Leave ${room.name}?`,
									detail: `This phone disconnects from ${room.name} and its desktops. Your place in the room is kept — scan any of its invites to come back. Other rooms aren't touched.`,
									action: `Leave ${room.name}`,
									run: () => onLeaveRoom(room.key),
								})
							}
						/>
					)}
				</div>
			</div>

			{confirm && (
				<ConfirmSheet
					title={confirm.title}
					detail={confirm.detail}
					action={confirm.action}
					onConfirm={confirm.run}
					onClose={() => setConfirm(null)}
				/>
			)}
		</div>
	);
}

/**
 * First launch: no room, so nothing to manage.
 *
 * The screen this replaced was the manager with its list emptied — titled
 * "Room", subtitled "Connections in this room.", describing a thing that did
 * not exist yet (A1). One mark, one sentence that teaches the model, one
 * button, and a footnote naming where the invite actually lives.
 */
function Welcome({ onJoin }: { onJoin(): void }) {
	return (
		<div className="flex h-full w-full flex-col bg-paper">
			<div className="flex flex-1 flex-col items-center justify-center gap-md px-gutter">
				<ToadMark className="!h-16 !w-32 text-ink-3" label="Toad" />
				<h1 className="font-display text-2xl text-ink">Toad</h1>
				<p className="max-w-[18rem] text-center text-lg leading-relaxed text-ink-3">
					A room is your team of agents across all your computers. Join one to get started.
				</p>
			</div>
			<footer className="safe-foot px-gutter pt-md">
				<button type="button" className="btn-primary w-full" onClick={onJoin}>
					Join a room
				</button>
				<p className="mt-sm text-center text-xs leading-relaxed text-ink-3">
					The invite is on any desktop in the room:
					<br />
					Settings → Room → Invite
				</p>
			</footer>
		</div>
	);
}

/** "2 desktops · joined Aug 27", from the oldest row the room holds. */
function subtitleOf(room: RoomEntry): string {
	const joined = Math.min(...room.desks.map((desk) => desk.pairedAt));
	const when = new Date(joined).toLocaleDateString(undefined, { month: "short", day: "numeric" });
	if (room.direct) return `direct link · linked ${when}`;
	const count = room.desks.length;
	return `${count} desktop${count === 1 ? "" : "s"} · joined ${when}`;
}

function RoomBody({
	room,
	activeId,
	status,
	onLeave,
}: {
	room: RoomEntry;
	activeId: string | null;
	status: InstanceStatus;
	onLeave(): void;
}) {
	/* The desk on the wire leads, then the rest by how recently they answered:
	 * the reading order matches what the section is telling you, which is that
	 * the room is up and this is the seat it gave you. */
	const desks = [...room.desks].sort((a, b) => {
		if (a.id === activeId) return -1;
		if (b.id === activeId) return 1;
		return b.lastSeenAt - a.lastSeenAt;
	});

	return (
		<>
			<p className="pset-label">Connection</p>
			<div className="pset-card">
				{desks.map((desk) => (
					<DeskRow key={desk.id} desk={desk} active={desk.id === activeId} status={status} />
				))}
			</div>
			<p className="pset-foot">
				Automatic — the app rides whichever desktop answers and walks when one goes quiet.
			</p>

			<ThisPhone />

			<div className="flex-1" />
			<footer className="safe-foot pt-lg">
				<button type="button" className="room-leave" onClick={onLeave}>
					Leave {room.name}
				</button>
			</footer>
		</>
	);
}

/**
 * A desktop, as detail.
 *
 * No IP on the face of it: the address is how the app finds the machine, not
 * how a person identifies it, and a row of bare `192.168.1.20`s is the single
 * clearest statement of the old machine-list model (E2). The dot carries
 * health, the caption carries which one you are riding, and nothing here is a
 * tap target — connection is the app's own job and the foot says so.
 */
function DeskRow({
	desk,
	active,
	status,
}: {
	desk: LinkedInstance;
	active: boolean;
	status: InstanceStatus;
}) {
	const vital = vitalOf(desk, active, status);
	const unlinked = desk.state === "unlinked";
	const caption = active && !unlinked
		? "your connection"
		: unlinked
			? "not linked any more"
			: `last seen ${since(desk.lastSeenAt)}`;

	return (
		<div className="pset-row">
			<span aria-hidden="true" className={`h-dot w-dot shrink-0 rounded-pill ${vital.className}`} />
			<span className="pset-row-stack">
				<span className="pset-row-name">{desk.name}</span>
				<span className={`pset-row-cap${active && !unlinked ? " ok" : ""}`}>{caption}</span>
			</span>
			<span className="sr-only">{vital.label}</span>
		</div>
	);
}

/**
 * What the room's desktops have this phone written down as.
 *
 * The fingerprint is the value someone reads aloud to confirm it is *this*
 * phone a desk's list is naming, so it is shown in the same four groups the
 * desktop prints, under the same words the desktop uses — "key fingerprint",
 * one term on both surfaces (G2).
 */
function ThisPhone() {
	const [me, setMe] = useState<{ name: string; fingerprint: string } | null>(null);
	useEffect(() => {
		let cancelled = false;
		void import("../node-identity")
			.then(({ mobileIdentity }) => mobileIdentity())
			.then((node) => {
				if (cancelled) return;
				setMe({
					name: node.name,
					fingerprint: node.fingerprint.match(/.{1,4}/g)?.slice(0, 4).join(" ") ?? "",
				});
			})
			// A webview too old to mint the key has no membership to describe.
			.catch(() => {});
		return () => {
			cancelled = true;
		};
	}, []);
	/* Section and footnote go together or not at all: the note is *about* the
	 * row, and on its own above the Leave button it reads as a caption for
	 * leaving. */
	if (!me) return null;
	return (
		<>
			<p className="pset-label">This phone</p>
			<div className="pset-card">
				<div className="pset-row">
					<span className="pset-row-stack">
						<span className="pset-row-name">{me.name}</span>
						{me.fingerprint && (
							<span className="pset-row-cap">key fingerprint {me.fingerprint}</span>
						)}
					</span>
				</div>
			</div>
			<p className="pset-foot">
				What this room's desktops list you as. Manage which desktops this phone may see from any
				desktop's Room settings.
			</p>
		</>
	);
}

/**
 * A desktop paired before rooms existed.
 *
 * One machine, one bearer token, nothing to be a member of — so none of the
 * room language above is true of it and it keeps the flow it had: relink when
 * the desktop stops accepting the token, forget when you are done with it.
 * The whole category leaves with legacy support.
 */
function DirectBody({
	room,
	status,
	onRelink,
	onForget,
	note,
}: {
	room: RoomEntry;
	status: InstanceStatus;
	onRelink(): void;
	onForget(): void;
	note: string | null;
}) {
	const desk = room.desks[0]!;
	const unlinked = desk.state === "unlinked";
	const vital = vitalOf(desk, true, status);
	return (
		<>
			<p className="pset-label">Connection</p>
			<div className="pset-card">
				<div className="pset-row">
					<span aria-hidden="true" className={`h-dot w-dot shrink-0 rounded-pill ${vital.className}`} />
					<span className="pset-row-stack">
						<span className="pset-row-name">{desk.name}</span>
						<span className={`pset-row-cap${unlinked ? "" : " ok"}`}>
							{unlinked ? "not linked any more" : "your connection"}
						</span>
					</span>
					{unlinked && (
						<button type="button" className="shrink-0 text-sm text-accent" onClick={onRelink}>
							Link again
						</button>
					)}
					<span className="sr-only">{vital.label}</span>
				</div>
			</div>
			<p className="pset-foot">
				A direct link to one desktop, made before rooms. It has no team around it — joining a room
				gives this phone every desktop in it at once.
			</p>

			<div className="flex-1" />
			<footer className="safe-foot pt-lg">
				{note && <p className="mb-xs text-xs text-ink-3">{note}</p>}
				<button type="button" className="room-leave" onClick={onForget}>
					Forget {desk.name}
				</button>
			</footer>
		</>
	);
}
