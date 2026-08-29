/* Hallmark · component: settings section · genre: modern-minimal · theme: project tokens
 * states: default · hover · focus-visible · active · disabled · loading · error · empty · pending
 * contrast: pass (40–41)
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import type {
	NodeIdentity,
	NodeMemberInfo,
	ProviderAuthInfo,
	RoomCredential,
} from "../../../../shared/types";
import { api } from "../../../rpc";
import { Section } from "../../fields";

/**
 * Provider keys as the whole room holds them — the way in, the way out, and
 * the way to see what is actually true right now.
 *
 * This sits inside the built-in agent's provider pane rather than in a pane of
 * its own, because it answers the same question the rest of that screen does:
 * can a teammate reach this provider, and from where. The sections above it
 * are about *this* desk's logins; this one is about the room.
 *
 * Two rules shape everything below.
 *
 * **Nothing is drawn from stored configuration.** Which desks hold a copy comes
 * from the record; whether a desk can be reached comes from its live NodeLink,
 * the same currency the room roster spends. A desk that is dark is drawn as
 * dark even though its row and its sealed copy are both still on disk — saying
 * "shared with beastie" about a machine nobody can reach would be a claim the
 * screen cannot support.
 *
 * **A withdrawal is reported as observed, never as issued.** Un-sharing deletes
 * the copies, but a desk that was asleep has not deleted anything yet. Those
 * desks are listed as still to confirm, in warning colours, until the owner has
 * asked them and heard that they hold nothing. There is no state in which this
 * screen says a copy is gone before somebody looked.
 *
 * Desktop only, and not by a check here: the phone gets `PhoneSettings`, which
 * has no provider screen at all, and the four mutations are refused over the
 * web wire by `DESKTOP_ONLY` even if a client invented a way to call them.
 */

const POLL_MS = 2_000;

/**
 * When a withdrawal was issued, in a sentence.
 *
 * The roster's `timeAgoShort` is written for a row with no room ("4m"); this
 * one lands mid-sentence in a warning an operator is reading rather than
 * scanning, and a withdrawal waiting since Tuesday should say Tuesday.
 */
function withdrawnWhen(at: number, now = Date.now()): string {
	const delta = Math.max(0, now - at);
	if (delta < 60_000) return "a moment ago";
	if (delta < 3_600_000) {
		const minutes = Math.floor(delta / 60_000);
		return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
	}
	if (delta < 86_400_000) {
		const hours = Math.floor(delta / 3_600_000);
		return `${hours} hour${hours === 1 ? "" : "s"} ago`;
	}
	return `on ${new Date(at).toLocaleDateString(undefined, { day: "numeric", month: "short" })}`;
}

/** A node id resolved against the room as it stands, not as it was configured. */
type Desk = {
	id: string;
	name: string;
	/** This desk. Always reachable, and labelled rather than dotted. */
	here: boolean;
	/** A live NodeLink stands right now. The only word on reachability. */
	linked: boolean;
	/** Still a member. False for a desk that has left with a copy behind. */
	member: boolean;
};

type Pending = {
	kind: "share" | "unshare" | "revoke" | "forget";
	credential: RoomCredential;
};

type Props = {
	/** The built-in agent's providers, for names and for the OAuth rows. */
	providers: ProviderAuthInfo[] | null;
	/** Sharing a key changes what pi reports as configured, so both lists move. */
	onProvidersChanged(): Promise<unknown>;
};

export function RoomKeys({ providers, onProvidersChanged }: Props) {
	const [credentials, setCredentials] = useState<RoomCredential[] | null>(null);
	const [members, setMembers] = useState<NodeMemberInfo[]>([]);
	const [identity, setIdentity] = useState<NodeIdentity | null>(null);
	const [busy, setBusy] = useState<string | null>(null);
	/* A refusal is carried with the key of whatever asked for it, so it can be
	 * drawn under that control. The store's refusals are whole sentences naming
	 * desks — reading one at the top of a long list, detached from the button
	 * that earned it, is how a good error message becomes a shrug. */
	const [error, setError] = useState<{ key: string; message: string } | null>(null);
	const [note, setNote] = useState("");
	const [pending, setPending] = useState<Pending | null>(null);
	const [adding, setAdding] = useState(false);
	const [draftProvider, setDraftProvider] = useState("");
	const [draftSecret, setDraftSecret] = useState("");
	const [draftLabel, setDraftLabel] = useState("");

	const refresh = useCallback(async () => {
		const [nextCredentials, nextMembers] = await Promise.all([
			api.credentialList(),
			api.nodeMembers(),
		]);
		setCredentials(nextCredentials);
		setMembers(nextMembers);
	}, []);

	useEffect(() => {
		void api.nodeInfo().then(setIdentity, () => undefined);
		void refresh().catch((cause) =>
			setError({
				key: "list",
				message: cause instanceof Error ? cause.message : String(cause),
			}),
		);
		/* Held copies and live links both move without this window doing
		 * anything — a peer opts in, a desk wakes up and its teardown settles —
		 * so the screen re-reads rather than trusting what it drew. */
		const timer = window.setInterval(() => void refresh().catch(() => undefined), POLL_MS);
		return () => window.clearInterval(timer);
	}, [refresh]);

	const deskOf = useCallback(
		(id: string): Desk => {
			if (identity && identity.id === id) {
				return { id, name: identity.name, here: true, linked: true, member: true };
			}
			const member = members.find((peer) => peer.id === id);
			if (member) {
				return {
					id,
					name: member.name,
					here: false,
					linked: member.wire?.up === true,
					member: true,
				};
			}
			return { id, name: `desk ${id.slice(0, 8)}`, here: false, linked: false, member: false };
		},
		[identity, members],
	);

	const nameOf = useCallback(
		(credential: RoomCredential): string => {
			const provider = (providers ?? []).find((entry) => entry.id === credential.providerId);
			if (credential.label && credential.label !== credential.providerId) return credential.label;
			return provider?.name ?? credential.providerId;
		},
		[providers],
	);

	const rows = useMemo(
		() => [...(credentials ?? [])].sort((a, b) => nameOf(a).localeCompare(nameOf(b))),
		[credentials, nameOf],
	);

	/** Providers pi takes a key for — including ones already signed in here. */
	const keyProviders = useMemo(
		() => (providers ?? []).filter((provider) => provider.apiKey),
		[providers],
	);

	/**
	 * Every other desktop in the room, as the share confirmation must name them.
	 *
	 * Sharing does not go to "the room" in the abstract; it puts a key on named
	 * machines, and the question deserves those names in front of it. Phones are
	 * not desks and never hold a key, so they are not in this list.
	 */
	const otherDesks = useMemo(
		() => members.filter((peer) => !peer.mobile).map((peer) => deskOf(peer.id)),
		[members, deskOf],
	);

	/**
	 * Subscription logins on this desk the room has not been told about.
	 *
	 * Listing one shares no bytes — an OAuth credential record is the *fact*
	 * that the login lives here. It is worth offering because it is the answer
	 * to the question this screen exists for: when a key dies or a rung refuses,
	 * where does the operator go to re-enter it.
	 */
	const unlistedLogins = useMemo(() => {
		if (!identity || credentials === null) return [];
		const listed = new Set(
			credentials
				.filter((credential) => credential.kind === "oauth" && credential.ownerNode === identity.id)
				.map((credential) => credential.providerId),
		);
		return (providers ?? []).filter(
			(provider) =>
				provider.configured &&
				provider.stored &&
				provider.credentialType === "oauth" &&
				!listed.has(provider.id),
		);
	}, [providers, credentials, identity]);

	const settle = async (message: string) => {
		setNote(message);
		await refresh().catch(() => undefined);
		await onProvidersChanged().catch(() => undefined);
	};

	/** Runs one mutation and reports whether it took, so a caller can keep a form open. */
	const run = async (
		key: string,
		action: () => Promise<{ ok: true } | { ok: false; error: string }>,
		success: string,
	): Promise<boolean> => {
		setBusy(key);
		setError(null);
		setNote("");
		try {
			const result = await action();
			if (!result.ok) {
				setError({ key, message: result.error });
				return false;
			}
			await settle(success);
			return true;
		} catch (cause) {
			setError({ key, message: cause instanceof Error ? cause.message : String(cause) });
			return false;
		} finally {
			setBusy(null);
			setPending(null);
		}
	};

	const addKey = async () => {
		const providerId = draftProvider.trim();
		const secret = draftSecret.trim();
		if (!providerId || !secret) return;
		const saved = await run(
			"add",
			() =>
				api.credentialCreate({
					providerId,
					kind: "api_key",
					...(draftLabel.trim() ? { label: draftLabel.trim() } : {}),
					secret,
				}),
			"Key saved on this desk. It stays here until you share it.",
		);
		/* A refused key stays in the field. Clearing it would make the operator
		 * fetch it again to read an error that is about the record, not the key. */
		if (!saved) return;
		setDraftSecret("");
		setDraftLabel("");
		setAdding(false);
	};

	const mine = (credential: RoomCredential) => identity !== null && credential.ownerNode === identity.id;

	return (
		<Section
			title="Across the room"
			hint="Provider keys Toad holds, and which desks hold them. Nothing travels until you share it, one key at a time."
		>
			{error?.key === "list" && <Refusal message={error.message} />}
			{note && !error && <p className="m-0 text-xs text-ink-3">{note}</p>}

			{credentials === null ? (
				<p className="m-0 text-xs text-ink-3">Reading the room's keys…</p>
			) : rows.length === 0 ? (
				<p className="m-0 text-xs leading-relaxed text-ink-3">
					No keys in this room yet. A key added here is Toad's own, kept for whichever desks you
					share it with — separate from the logins above, which belong to this desk alone.
				</p>
			) : (
				<ul className="flex flex-col divide-y divide-rule-2 border-y border-rule-2">
					{rows.map((credential) => (
						<CredentialRow
							key={credential.id}
							credential={credential}
							name={nameOf(credential)}
							owner={deskOf(credential.ownerNode)}
							holders={holdersOf(credential).map(deskOf)}
							otherDesks={otherDesks}
							waiting={(credential.teardown?.pending ?? []).map(deskOf)}
							mine={mine(credential)}
							busy={busy === credential.id}
							refusal={error?.key === credential.id ? error.message : ""}
							pending={pending?.credential.id === credential.id ? pending.kind : null}
							onAsk={(kind) => {
								setError(null);
								setNote("");
								setPending({ kind, credential });
							}}
							onCancel={() => setPending(null)}
							onConfirm={(kind) => {
								if (kind === "share") {
									void run(
										credential.id,
										() => api.credentialSetReplication(credential.id, true),
										"Shared. Every desk in the room gets its own sealed copy.",
									);
								} else if (kind === "unshare") {
									void run(
										credential.id,
										() => api.credentialSetReplication(credential.id, false),
										"Withdrawn. Copies are deleted as each desk hears; any desk still to confirm is listed below.",
									);
								} else if (kind === "revoke") {
									void run(
										credential.id,
										() => api.credentialRevoke(credential.id),
										"Revoked. Every desk that hears drops its copy.",
									);
								} else {
									void run(credential.id, () => api.credentialDelete(credential.id), "Forgotten.");
								}
							}}
						/>
					))}
				</ul>
			)}

			{adding ? (
				<form
					className="flex flex-col gap-xs border-y border-rule-2 py-sm"
					onSubmit={(event) => {
						event.preventDefault();
						void addKey();
					}}
				>
					<p className="label">Add a key to this room</p>
					{providers === null ? (
						<p className="m-0 text-xs text-ink-3">Reading providers…</p>
					) : keyProviders.length === 0 ? (
						<p className="m-0 text-xs text-ink-3">No provider here takes an API key.</p>
					) : (
						<>
							<select
								className="field"
								aria-label="Provider"
								value={draftProvider}
								onChange={(event) => setDraftProvider(event.target.value)}
							>
								<option value="">Choose a provider…</option>
								{keyProviders.map((provider) => (
									<option key={provider.id} value={provider.id}>
										{provider.name}
									</option>
								))}
							</select>
							<input
								type="password"
								className="field font-mono text-2xs"
								aria-label="API key"
								placeholder="Paste the key"
								autoComplete="off"
								value={draftSecret}
								onChange={(event) => setDraftSecret(event.target.value)}
							/>
							<input
								className="field text-sm"
								aria-label="Label"
								placeholder="Label (optional) — what you call this key"
								value={draftLabel}
								onChange={(event) => setDraftLabel(event.target.value)}
							/>
							<p className="m-0 text-xs leading-relaxed text-ink-3">
								Saved on this desk only. Sharing it with the room is a separate decision you make
								on its row, and it is off until you make it.
							</p>
							{error?.key === "add" && <Refusal message={error.message} />}
							<div className="flex gap-xs">
								<button
									type="submit"
									className="btn-primary"
									disabled={busy === "add" || !draftProvider || !draftSecret.trim()}
								>
									{busy === "add" ? "Saving…" : "Save key"}
								</button>
								<button
									type="button"
									className="btn-ghost"
									onClick={() => {
										setAdding(false);
										setDraftSecret("");
										setError(null);
									}}
								>
									Cancel
								</button>
							</div>
						</>
					)}
				</form>
			) : (
				<button
					type="button"
					className="btn-outline self-start"
					onClick={() => {
						setAdding(true);
						setError(null);
						setNote("");
					}}
				>
					Add a key
				</button>
			)}

			{unlistedLogins.length > 0 && (
				<div className="flex flex-col gap-xs">
					<p className="m-0 text-xs leading-relaxed text-ink-3">
						Signed in on this desk but not listed for the room. Listing one shares no tokens — it
						records which desk the login lives on, so the room can say where to go when a rung
						refuses.
					</p>
					<ul className="flex flex-col divide-y divide-rule-2 border-y border-rule-2">
						{unlistedLogins.map((provider) => (
							<li key={provider.id} className="flex items-center gap-sm py-xs">
								<span className="min-w-0 flex-1 text-sm text-ink">{provider.name}</span>
								<button
									type="button"
									className="btn-ghost shrink-0 whitespace-nowrap"
									disabled={busy === `oauth:${provider.id}`}
									onClick={() =>
										void run(
											`oauth:${provider.id}`,
											() =>
												api.credentialCreate({
													providerId: provider.id,
													kind: "oauth",
													label: provider.name,
												}),
											`The room now knows ${provider.name} is signed in here.`,
										)
									}
								>
									Tell the room
								</button>
							</li>
						))}
					</ul>
					{error?.key.startsWith("oauth:") && <Refusal message={error.message} />}
				</div>
			)}

			{/* 4.5, said where an operator meets it rather than in a doc. An
			    external harness authenticates itself in its own config, and Toad
			    speaks its protocol rather than its login — so a room key reaches
			    the built-in agent and nothing else. */}
			<p className="m-0 text-xs leading-relaxed text-ink-3">
				These keys are used by Toad Agent teammates. Cursor, Claude Code and other external
				backends sign in through their own config; Toad speaks their protocol, not their login,
				so a shared key does not reach them.
			</p>
		</Section>
	);
}

/**
 * A refusal from the store, verbatim.
 *
 * These are already whole sentences written for an operator — the OAuth one
 * carries the rotation reason, the delete one names the desks still holding a
 * copy — so nothing here paraphrases or truncates them.
 */
function Refusal({ message }: { message: string }) {
	return (
		<p
			role="alert"
			className="m-0 border-y border-danger-edge bg-danger-wash px-sm py-xs text-xs leading-relaxed text-danger"
		>
			{message}
		</p>
	);
}

/** Every desk holding material: the owner in plaintext, the rest sealed. */
function holdersOf(credential: RoomCredential): string[] {
	if (credential.revoked) return [];
	return [
		credential.ownerNode,
		...credential.sealedTo.filter((id) => id !== credential.ownerNode),
	];
}

function CredentialRow({
	credential,
	name,
	owner,
	holders,
	otherDesks,
	waiting,
	mine,
	busy,
	refusal,
	pending,
	onAsk,
	onCancel,
	onConfirm,
}: {
	credential: RoomCredential;
	name: string;
	owner: Desk;
	holders: Desk[];
	/** Every other desktop in the room — who a share would reach. */
	otherDesks: Desk[];
	waiting: Desk[];
	mine: boolean;
	busy: boolean;
	/** The store's own words when this row's last act was refused. */
	refusal: string;
	pending: Pending["kind"] | null;
	onAsk(kind: Pending["kind"]): void;
	onCancel(): void;
	onConfirm(kind: Pending["kind"]): void;
}) {
	const oauth = credential.kind === "oauth";

	return (
		<li className="flex flex-col gap-2xs py-sm">
			<div className="flex items-start gap-sm">
				<span
					aria-hidden="true"
					className={`mt-2xs h-dot w-dot shrink-0 rounded-pill ${
						credential.revoked ? "bg-danger" : credential.usableHere ? "bg-accent" : "bg-rule-strong"
					}`}
				/>
				<span className="min-w-0 flex-1">
					<span className="block text-sm text-ink">{name}</span>
					<span className="block text-2xs text-ink-3">
						{owner.here ? "Entered on this desk" : `Entered on ${owner.name}`}
						{credential.usableHere && !owner.here && " · usable here"}
					</span>
				</span>
				{!mine && (
					<span className="shrink-0 text-2xs text-ink-3">managed on {owner.name}</span>
				)}
			</div>

			<div className="pl-sm">
				{credential.revoked ? (
					<p className="m-0 text-xs leading-relaxed text-danger">
						Revoked. Every desk that has heard has dropped its copy; a key that comes back is a new
						one.
					</p>
				) : oauth ? (
					<p className="m-0 text-xs leading-relaxed text-ink-3">
						Bound to {owner.here ? "this desk" : owner.name} and stays there. OAuth rotates its
						refresh token when it is used, so two desks refreshing at once would invalidate each
						other. Enter an API key to share a provider across desks.
					</p>
				) : credential.replicate ? (
					<Holders holders={holders} />
				) : (
					<p className="m-0 text-xs leading-relaxed text-ink-3">
						Only on {owner.here ? "this desk" : owner.name}. Not shared with any other desk.
					</p>
				)}
			</div>

			{waiting.length > 0 && (
				<div className="ml-sm border-y border-warn-edge bg-warn-wash px-sm py-xs">
					<p className="m-0 text-xs leading-relaxed text-ink-2">
						Withdrawn {withdrawnWhen(credential.teardown?.at ?? Date.now())} — still to confirm on{" "}
						{waiting.length === 1 ? "one desk" : `${waiting.length} desks`}.
					</p>
					<ul className="mt-2xs flex flex-col gap-3xs">
						{waiting.map((desk) => (
							<li key={desk.id} className="text-2xs text-ink-3">
								<span className="text-ink-2">{desk.here ? "this desk" : desk.name}</span>
								{" — "}
								{!desk.member
									? "no longer in this room; it drops out of the wait on the next sweep"
									: desk.linked
										? "connected; confirming now"
										: "no link right now — the copy goes when it comes back"}
							</li>
						))}
					</ul>
				</div>
			)}

			{refusal && (
				<div className="pl-sm">
					<Refusal message={refusal} />
				</div>
			)}

			{mine && !pending && (
				<div className="flex flex-wrap gap-xs pl-sm">
					{/* Sharing and revoking are about a key; an OAuth row is a fact
					    about where a login lives, and there is no key here to move
					    or to kill. Forgetting the fact is the whole way out. */}
					{!credential.revoked && !oauth && (
						<>
							<button
								type="button"
								className={credential.replicate ? "btn-ghost" : "btn-outline"}
								disabled={busy}
								onClick={() => onAsk(credential.replicate ? "unshare" : "share")}
							>
								{credential.replicate ? "Stop sharing" : "Share with the room"}
							</button>
							<button
								type="button"
								className="btn-ghost"
								disabled={busy}
								onClick={() => onAsk("revoke")}
							>
								Revoke
							</button>
						</>
					)}
					<button type="button" className="btn-ghost" disabled={busy} onClick={() => onAsk("forget")}>
						Forget
					</button>
				</div>
			)}

			{mine && pending && (
				<Confirm
					kind={pending}
					name={name}
					/* Sharing reaches the room as it stands now; withdrawing
					 * reaches the desks that actually took a copy. Naming the
					 * wrong set would make the sentence a guess. */
					desks={
						pending === "share" ? otherDesks : holders.filter((desk) => !desk.here)
					}
					busy={busy}
					onCancel={onCancel}
					onConfirm={() => onConfirm(pending)}
				/>
			)}
		</li>
	);
}

/**
 * Which desks hold a copy, each with the room's live word on reaching it.
 *
 * A desk that is dark still holds ciphertext, and this says exactly that
 * rather than either hiding the row or drawing it as if the link were up.
 */
function Holders({ holders }: { holders: Desk[] }) {
	if (holders.length <= 1) {
		return (
			<p className="m-0 text-xs leading-relaxed text-ink-3">
				Shared, but no other desk holds a copy yet — no other desktop has joined this room.
			</p>
		);
	}
	return (
		<div>
			<p className="m-0 text-xs text-ink-3">
				Shared — {holders.length} {holders.length === 1 ? "desk holds" : "desks hold"} a copy:
			</p>
			<ul className="mt-3xs flex flex-col gap-3xs">
				{holders.map((desk, index) => (
					<li key={desk.id} className="flex items-center gap-2xs text-2xs">
						<span
							aria-hidden="true"
							className={`h-dot w-dot shrink-0 rounded-pill ${
								desk.linked ? "bg-accent" : "bg-rule-strong"
							}`}
						/>
						<span className="text-ink-2">{desk.here ? "this desk" : desk.name}</span>
						<span className="text-ink-3">
							{index === 0
								? "the key itself"
								: !desk.member
									? "left the room — its copy is inert, nothing seals to it"
									: desk.linked
										? "sealed copy"
										: "sealed copy · no link right now"}
						</span>
					</li>
				))}
			</ul>
		</div>
	);
}

/**
 * The consequence, stated before it happens, in the place it happens.
 *
 * Every one of these is a door that only opens one way, so each says what it
 * actually does to other machines — including the at-rest limit, which belongs
 * exactly here: at the moment somebody decides a secret should travel.
 */
function Confirm({
	kind,
	name,
	desks,
	busy,
	onCancel,
	onConfirm,
}: {
	kind: Pending["kind"];
	name: string;
	/** The machines this act reaches, by name. Empty when it reaches none. */
	desks: Desk[];
	busy: boolean;
	onCancel(): void;
	onConfirm(): void;
}) {
	const named = desks.map((desk) => desk.name).join(", ");
	const destructive = kind !== "share";
	const copy: Record<Pending["kind"], { title: string; body: string; action: string }> = {
		share: {
			title: `Share ${name} with every desk in this room?`,
			body:
				(named
					? `This puts a copy of the key on ${named}. `
					: "No other desktop has joined this room yet, so nothing is copied today — but any desk that joins later is sealed a copy. ") +
				"Each desk gets its own sealed copy, unreadable to the other desks, to a backup and to a " +
				"synced folder. It is not unreadable to a program running as you on that desk — which is " +
				"why this is per key and off by default. Share it only with desks you would hand it to.",
			action: "Share with the room",
		},
		unshare: {
			title: `Stop sharing ${name}?`,
			body: named
				? `This deletes the copies on ${named}. Each desk drops it the moment it hears. A desk that is ` +
					"offline is torn down when it comes back, and stays listed here as not yet confirmed until it does."
				: "This withdraws the copies. A desk that is offline is torn down when it comes back, and stays listed here until it does.",
			action: "Delete the copies",
		},
		revoke: {
			title: `Revoke ${name}?`,
			body:
				"For a key the provider has already killed. It dies on every desk that hears, including this " +
				"one, whether or not it was ever shared. This cannot be undone — a key that comes back is a new one.",
			action: "Revoke everywhere",
		},
		forget: {
			title: `Forget ${name}?`,
			body:
				"Removes the record from the room and the key from this desk. Refused while a withdrawal is " +
				"still waiting on a desk, because this record is the only account of which desks have not dropped it.",
			action: "Forget it",
		},
	};
	const { title, body, action } = copy[kind];

	return (
		<div
			role="group"
			aria-label={title}
			className={`ml-sm border-y px-sm py-xs ${
				destructive ? "border-danger-edge bg-danger-wash" : "border-accent-edge bg-accent-wash"
			}`}
		>
			<p className="m-0 text-xs font-medium text-ink">{title}</p>
			<p className="mt-2xs text-xs leading-relaxed text-ink-2">{body}</p>
			<div className="mt-xs flex gap-xs">
				<button
					type="button"
					className={destructive ? "btn-danger" : "btn-primary"}
					disabled={busy}
					onClick={onConfirm}
				>
					{busy ? "Working…" : action}
				</button>
				<button type="button" className="btn-ghost" disabled={busy} onClick={onCancel}>
					Cancel
				</button>
			</div>
		</div>
	);
}
