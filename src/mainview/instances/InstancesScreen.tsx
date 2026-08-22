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

export function InstancesScreen({
	instances,
	activeId,
	status,
	onPick,
	onLink,
	onForget,
	onClose,
}: Props) {
	const [popup, setPopup] = useState<{ x: number; y: number; items: PopupItem[] } | null>(null);
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
		<div className="flex h-full w-full flex-col overflow-y-auto bg-paper">
			<header className="flex items-start gap-xs px-gutter pb-md pt-lg">
				{onClose && (
					<button
						type="button"
						className="btn-ghost -ml-2xs shrink-0 !px-2xs"
						aria-label="Back to the conversation"
						onClick={onClose}
					>
						<BackIcon />
					</button>
				)}
				<div className="min-w-0">
					<h1 className="font-display text-xl text-ink">Instances</h1>
					<p className="mt-3xs text-sm text-ink-3">Desktops this phone is linked to.</p>
				</div>
			</header>

			{instances.length === 0 ? (
				<div className="flex flex-1 flex-col items-center justify-center gap-md px-gutter pb-2xl">
					<ToadMark className="text-ink-3" label="Toad" />
					<p className="text-center text-sm text-ink-3">Link your desktop to get started.</p>
					<button type="button" className="btn-primary" onClick={() => onLink()}>
						Link a desktop
					</button>
				</div>
			) : (
				<>
					<ul className="flex flex-1 flex-col gap-2xs px-gutter">
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

					<footer className="px-gutter pb-lg pt-md">
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
		<li className="flex items-center gap-sm rounded-lg bg-paper-2 p-sm">
			<span
				aria-hidden="true"
				className="flex h-8 w-8 shrink-0 items-center justify-center rounded-sm bg-paper-3 font-display text-sm text-ink-2"
			>
				{monogramOf(instance.name)}
			</span>

			<button type="button" className="min-w-0 flex-1 text-left" onClick={onPick}>
				<span className="flex items-center gap-2xs">
					<span className="truncate font-display text-md text-ink">{instance.name}</span>
					<span
						aria-hidden="true"
						className={`h-dot w-dot shrink-0 rounded-pill ${vital.className}`}
					/>
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
