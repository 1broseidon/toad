import { type MouseEvent, useState } from "react";
import { PopupMenu, type PopupItem } from "../components/PopupMenu";
import { ToadMark } from "../components/ToadMark";
import { BackIcon, MoreIcon } from "../components/icons";
import { hostOf, monogramOf, since, vitalOf } from "./marks";
import type { LinkedInstance } from "./store";
import type { InstanceStatus } from "./useInstances";

/**
 * The desktops this phone knows about.
 *
 * The app's first screen when nothing is linked, and the way back to this
 * question afterwards. It is a list of machines, not of teammates: the
 * roster lives on the other side of whichever one is picked.
 */

type Props = {
	instances: LinkedInstance[];
	activeId: string | null;
	status: InstanceStatus;
	/** Speak to this desktop, and get out of the way. */
	onPick(id: string): void;
	/** Link a desktop. Given a row, it is that one being linked again. */
	onLink(instance?: LinkedInstance): void;
	/**
	 * Drop the row. Revoking on the desktop is attempted first by the caller,
	 * and reports back whether it landed — an unreachable desktop still holds
	 * the device in its list.
	 */
	onForget(instance: LinkedInstance): Promise<boolean>;
	/** Back to the conversation, where there is one to go back to. */
	onClose?(): void;
};

export function InstancesScreen({ instances, activeId, status, onPick, onLink, onForget, onClose }: Props) {
	const [popup, setPopup] = useState<{
		x: number;
		y: number;
		items: PopupItem[];
	} | null>(null);
	/* Forgetting is not undoable from here — the token is gone and the code
	 * that made it expired minutes ago — so the item asks once more first. */
	const [confirming, setConfirming] = useState<string | null>(null);
	const [note, setNote] = useState<string | null>(null);

	const forget = (instance: LinkedInstance) => {
		if (confirming !== instance.id) {
			setConfirming(instance.id);
			return;
		}
		setConfirming(null);
		void onForget(instance).then((revoked) => {
			if (!revoked) setNote("Removed here. Revoke it on that desktop too.");
		});
	};

	const openMenu = (instance: LinkedInstance, event: MouseEvent) => {
		if (confirming !== null && confirming !== instance.id) setConfirming(null);
		setPopup({
			x: event.clientX,
			y: event.clientY,
			items: [
				{
					label: confirming === instance.id ? "Forget — really?" : "Forget this instance",
					danger: true,
					onClick: () => forget(instance),
				},
			],
		});
	};

	return (
		/* The title is fixed and the list scrolls under it, the way the roster's
		   does. Scrolling the whole screen instead would slide a 34px heading up
		   behind the status bar, and there is no band up there to hide it. */
		<div className="flex h-full w-full flex-col bg-paper">
			<header className="safe-head flex items-start gap-sm px-gutter pb-lg">
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
				<div className="min-w-0">
					<h1 className="font-display text-2xl text-ink">Desktops</h1>
					<p className="mt-2xs text-md leading-relaxed text-ink-3">Desktops this phone is linked to.</p>
				</div>
			</header>

			{instances.length === 0 ? (
				<>
					<div className="flex flex-1 flex-col items-center justify-center gap-md px-gutter">
						<ToadMark className="!h-16 !w-32 text-ink-3" label="Toad" />
						<p className="max-w-[18rem] text-center text-lg leading-relaxed text-ink-3">
							Link your desktop to get started.
						</p>
					</div>
					<footer className="safe-foot px-gutter pt-md">
						<button type="button" className="btn-primary w-full" onClick={() => onLink()}>
							Link a desktop
						</button>
					</footer>
				</>
			) : (
				<>
					<ul className="flex min-h-0 flex-1 flex-col gap-2xs overflow-y-auto px-gutter">
						{instances.map((instance) => (
							<Row
								key={instance.id}
								instance={instance}
								active={instance.id === activeId}
								status={status}
								onPick={() => onPick(instance.id)}
								onRelink={() => onLink(instance)}
								onMenu={(event) => openMenu(instance, event)}
							/>
						))}
					</ul>

					<footer className="safe-foot px-gutter pt-md">
						{note && <p className="mb-xs text-xs text-ink-3">{note}</p>}
						<button type="button" className="btn-primary w-full" onClick={() => onLink()}>
							Link a desktop
						</button>
					</footer>
				</>
			)}

			{popup && (
				<PopupMenu x={popup.x} y={popup.y} items={popup.items} onClose={() => setPopup(null)} />
			)}
		</div>
	);
}

function Row({
	instance,
	active,
	status,
	onPick,
	onRelink,
	onMenu,
}: {
	instance: LinkedInstance;
	active: boolean;
	status: InstanceStatus;
	onPick(): void;
	onRelink(): void;
	onMenu(event: MouseEvent): void;
}) {
	const vital = vitalOf(instance, active, status);
	const unlinked = instance.state === "unlinked";
	// The dot only says something live for the desktop on the wire; the rest
	// report when they were last heard from.
	const live = active && !unlinked;

	return (
		<li className="flex min-h-[4.5rem] items-center gap-sm rounded-xl bg-paper-2 px-md py-sm">
			<span
				aria-hidden="true"
				className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg bg-paper-3 font-display text-lg text-ink-2"
			>
				{monogramOf(instance.name)}
			</span>

			<button type="button" className="min-w-0 flex-1 py-xs text-left" onClick={onPick}>
				<span className="flex items-center gap-2xs">
					<span className="truncate font-display text-lg text-ink">{instance.name}</span>
					<span aria-hidden="true" className={`h-dot w-dot shrink-0 rounded-pill ${vital.className}`} />
					<span className="sr-only">{vital.label}</span>
				</span>
				<span className="block truncate font-mono text-xs text-ink-3">
					{hostOf(instance.origin)}
				</span>
				{!live && (
					<span className="block text-xs text-ink-3">
						{unlinked ? "not linked any more" : `last seen ${since(instance.lastSeenAt)}`}
					</span>
				)}
			</button>

			{unlinked && (
				<button type="button" className="shrink-0 text-sm text-accent" onClick={onRelink}>
					Link again
				</button>
			)}

			<button
				type="button"
				className="btn-ghost shrink-0 !px-2xs"
				aria-label={`More for ${instance.name}`}
				onClick={onMenu}
			>
				<MoreIcon />
			</button>
		</li>
	);
}
