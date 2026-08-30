import { useEffect, useRef, useState } from "react";
import type { NotifyPrefs, PushPhoneReach, PushStatus } from "../../../../shared/types";
import { webClient } from "../../../platform";
import { api } from "../../../rpc";
import { Field, Section, SettingsToggle } from "../../fields";

/**
 * Two destinations, one judgement: which moments are worth interrupting.
 *
 * The phone half is push — a key, paired devices, a doorbell over APNs.
 * The desktop half is local: the same three kinds, posted by bun to the OS
 * when this window is not already looking. See docs/push.md.
 */

type Kind = "turnEnded" | "permission" | "blocked";

/**
 * What Apple's rejection actually means for the person reading it.
 *
 * The raw reason stays on screen — it is the precise, searchable truth — but
 * the two failures anyone hits while setting this up deserve a sentence
 * about what to change rather than a term of art.
 */
const REASONS: Record<string, string> = {
	InvalidProviderToken: "Apple didn't recognise that key — check the Key ID and Team ID match the .p8.",
	ExpiredProviderToken: "The signing token went stale. Try again.",
	BadDeviceToken: "That phone registered against a different build of the app. Reopen Toad on it.",
	NoCredentials: "No key installed yet.",
	TopicDisallowed: "The key isn't enabled for this app's bundle id.",
};

/**
 * How often the reach list re-asks the room.
 *
 * Reach is not configuration — it changes when a link drops, not when somebody
 * types — so a value read once on mount would be a screen that quietly goes
 * wrong while it is open. The Room pane polls its roster on the same reasoning
 * and at the same order of magnitude.
 */
const REACH_POLL_MS = 3_000;

const KINDS: Array<{ id: Kind; label: string; hint: string }> = [
	{ id: "turnEnded", label: "A teammate finishes", hint: "The turn you sent ended and it's ready for you." },
	{ id: "permission", label: "A teammate needs you", hint: "A permission, or something it asked you to do by hand." },
	{ id: "blocked", label: "A teammate gets stuck", hint: "It stopped on an error." },
];

function KindToggles({
	prefs,
	onUpdate,
}: {
	prefs: NotifyPrefs | undefined;
	onUpdate(patch: Partial<NotifyPrefs>): void;
}) {
	return (
		<>
			{KINDS.map((kind) => (
				<Field key={kind.id} label={kind.label} hint={kind.hint}>
					<SettingsToggle
						label="Notify"
						checked={prefs?.[kind.id] !== false}
						onChange={(event) => onUpdate({ [kind.id]: event.target.checked })}
					/>
				</Field>
			))}
		</>
	);
}

/**
 * One phone, and what would actually happen if a teammate finished right now.
 *
 * Three lines, in order of what a person is asking. The name. Then the verdict,
 * which names a *desk* rather than saying "on" — since the address replicated,
 * "reachable" without "from where" is the half-answer that hides a room one
 * sleeping machine away from silence. Then who holds what, so the verdict is
 * checkable rather than trusted.
 */
function PhoneRow({ phone }: { phone: PushPhoneReach }) {
	const verdict = phone.sendsHere
		? { tone: "text-accent", text: "Reachable — this desk would send." }
		: phone.senderName
			? { tone: "text-ink-2", text: `Reachable — ${phone.senderName} would send.` }
			: phone.quiet === "no-key"
				? {
						tone: "text-warn",
						text: "No desk holding this phone's address holds the signing key, so nothing can be sent to it. Share the key under Agents → Room keys.",
					}
				: phone.quiet === "no-desk"
					? {
							tone: "text-warn",
							text: "Every desk that could sign for this phone is offline. Nothing reaches it until one of them is back.",
						}
					: phone.quiet === "dead"
						? {
								tone: "text-warn",
								text: "Apple rejected this address. Open Toad on the phone to register a new one.",
							}
						: {
								tone: "text-ink-3",
								text:
									phone.pending.length > 0
										? `Being removed — waiting on ${phone.pending.join(", ")}.`
										: "Being removed.",
							};

	/* Only the departures from healthy are marked. A desk that holds the address,
	 * holds the key and answers needs no adjective; the ones that read as an
	 * explanation are exactly the ones that are missing something. */
	const held = phone.desks.map((desk) => {
		const marks = [
			...(desk.here ? ["this desk"] : []),
			...(desk.owner ? ["paired it"] : []),
			...(desk.signs ? [] : ["no key"]),
			...(desk.up ? [] : ["offline"]),
		];
		return marks.length > 0 ? `${desk.name} (${marks.join(", ")})` : desk.name;
	});

	return (
		<li className="flex flex-col gap-2xs py-xs">
			<span className="text-sm text-ink">{phone.name}</span>
			<span className={`text-xs leading-relaxed ${verdict.tone}`}>{verdict.text}</span>
			{held.length > 0 && (
				<span className="text-2xs text-ink-3">Address held by {held.join(" · ")}</span>
			)}
		</li>
	);
}

export function Notifications({
	push,
	desktop,
	onUpdatePush,
	onUpdateDesktop,
}: {
	push: NotifyPrefs | undefined;
	desktop: NotifyPrefs | undefined;
	onUpdatePush(patch: Partial<NotifyPrefs>): void;
	onUpdateDesktop(patch: Partial<NotifyPrefs>): void;
}) {
	const [status, setStatus] = useState<PushStatus | null>(null);
	const [installing, setInstalling] = useState(false);
	const [error, setError] = useState("");
	const [keyId, setKeyId] = useState("");
	const [teamId, setTeamId] = useState("");
	const [testing, setTesting] = useState(false);
	const [tested, setTested] = useState<{ sent: number; failed: { reason: string }[] } | null>(null);
	const [desktopTesting, setDesktopTesting] = useState(false);
	const [desktopTested, setDesktopTested] = useState<boolean | null>(null);
	const file = useRef<HTMLInputElement>(null);
	const [fileName, setFileName] = useState("");
	const [pem, setPem] = useState("");

	const [reach, setReach] = useState<PushPhoneReach[] | null>(null);

	useEffect(() => {
		void api.getPushStatus().then(setStatus, () => undefined);
	}, []);

	useEffect(() => {
		let cancelled = false;
		const read = () =>
			api.getPushReach().then(
				(next) => {
					if (!cancelled) setReach(next);
				},
				() => undefined,
			);
		void read();
		const timer = window.setInterval(() => void read(), REACH_POLL_MS);
		return () => {
			cancelled = true;
			window.clearInterval(timer);
		};
	}, []);

	const install = async () => {
		if (!pem || !keyId.trim() || !teamId.trim()) return;
		setInstalling(true);
		setError("");
		try {
			const result = await api.installPushKey(pem, keyId.trim(), teamId.trim());
			if (!result.ok) {
				setError(result.error ?? "That key didn't take.");
				return;
			}
			setStatus(await api.getPushStatus());
			setPem("");
			setFileName("");
			setKeyId("");
			setTeamId("");
		} finally {
			setInstalling(false);
		}
	};

	const clear = async () => {
		setStatus(await api.clearPushKey());
		setTested(null);
	};

	/* Also re-reads the status, because the count of phones worth buzzing is
	 * the other half of the answer: a test that sent to nobody is not a
	 * failure, it is a phone that has not registered yet. */
	const test = async () => {
		setTesting(true);
		setTested(null);
		try {
			const [result, next] = await Promise.all([api.sendTestPush(), api.getPushStatus()]);
			setTested(result);
			setStatus(next);
		} finally {
			setTesting(false);
		}
	};

	const testDesktop = async () => {
		setDesktopTesting(true);
		setDesktopTested(null);
		try {
			const result = await api.sendTestDesktop();
			setDesktopTested(result.sent);
		} finally {
			setDesktopTesting(false);
		}
	};

	const phoneOn = push?.enabled ?? false;
	const desktopOn = desktop?.enabled !== false;
	const isWeb = webClient();

	const desktopSection = (
		<>
			<Field
				label="Show desktop notifications"
				hint="When this window is unfocused, hidden, or looking at someone else."
			>
				<SettingsToggle
					label="Show desktop notifications"
					checked={desktopOn}
					onChange={(event) => onUpdateDesktop({ enabled: event.target.checked })}
				/>
			</Field>
			{desktopOn && <KindToggles prefs={desktop} onUpdate={onUpdateDesktop} />}
			<Field label="Try it">
				<div className="flex flex-col gap-2xs">
					<button
						type="button"
						className="btn-outline w-fit"
						disabled={desktopTesting || !desktopOn}
						onClick={() => void testDesktop()}
					>
						{desktopTesting ? "Sending…" : "Send a test"}
					</button>
					{desktopTested === true && (
						<p className="m-0 text-xs text-accent">Sent. Check the notification area.</p>
					)}
					{desktopTested === false && (
						<p className="m-0 text-xs text-danger">That didn't land. This desktop may not have a notifier.</p>
					)}
				</div>
			</Field>
		</>
	);

	const master = (
		<Field label="Notify a paired phone">
			<SettingsToggle
				label="Send push notifications"
				checked={phoneOn}
				disabled={status === null}
				onChange={(event) => onUpdatePush({ enabled: event.target.checked })}
			/>
		</Field>
	);
	const events = phoneOn ? <KindToggles prefs={push} onUpdate={onUpdatePush} /> : null;

	/* Two things this desk should say about itself before the list is read, both
	 * about the same failure: a room that looks configured and is one asleep
	 * machine away from silence. Neither is inferable from a phone's row — the
	 * first is about this desk holding no key at all, the second about it being
	 * the only desk that holds one — so they are said here, once, in words. */
	const otherDesks = (reach ?? []).some((phone) => phone.desks.some((desk) => !desk.here));
	const roomSends = (reach ?? []).some((phone) => phone.senderNode !== null);
	const deskWarning =
		reach === null || reach.length === 0
			? null
			: status && !status.configured
				? roomSends
					? "This desk holds no signing key, so it never posts to a phone itself — another desk sends for the room."
					: "This desk holds no signing key, and neither does any other desk here. Nothing can reach a phone until one is installed."
				: status?.configured && status.keyFrom === "here" && !status.keyReplicated && otherDesks
					? "Only this desk can sign. While it is asleep or offline, nothing reaches your phone — share the key under Agents → Room keys so the other desks can send too."
					: null;

	const phones = (
		<Field
			label="Phones"
			hint="Asked of the room right now, not read from what was set up: which desks hold each phone's address, which of those hold the signing key, and which one would actually post."
		>
			<div className="flex flex-col gap-xs">
				{deskWarning && <p className="m-0 text-xs leading-relaxed text-warn">{deskWarning}</p>}
				{reach === null ? (
					<p className="m-0 text-xs text-ink-3">Asking the room…</p>
				) : reach.length === 0 ? (
					<p className="m-0 text-xs leading-relaxed text-ink-3">
						No paired phone has registered yet. A phone registers the first time you open Toad on
						it after joining this room.
					</p>
				) : (
					<ul className="flex flex-col divide-y divide-rule-2 border-y border-rule-2">
						{reach.map((phone) => (
							<PhoneRow key={phone.key} phone={phone} />
						))}
					</ul>
				)}
			</div>
		</Field>
	);
	const signingKey = (
		<Field
				label={isWeb ? "Signing key" : "APNs key"}
				hint="From developer.apple.com → Certificates, Identifiers & Profiles → Keys — create one with Apple Push Notifications service checked, then drop the downloaded .p8 here with its Key ID."
			>
				{status?.configured ? (
					<div className="flex flex-col gap-2xs">
						<p className="m-0 text-sm text-ink">
							Key <span className="font-mono text-ink-2">{status.keyId}</span> · team{" "}
							<span className="font-mono text-ink-2">{status.teamId}</span>
						</p>
						{/* Where the key came from and where it went — and nothing
						    about which phones it reaches, which is the Phones field's
						    answer: a list naming a desk, where a count here would be a
						    second and weaker copy of it. A desk nobody typed a key into
						    can still send, because the owning desk shared it, and saying
						    so is what keeps "configured" from reading as a machine
						    remembering something it never did. The unshared case is
						    deliberately silent here; it only matters when there is
						    another desk to share with, and the Phones field says it
						    there, in front of the phones it affects. */}
						{status.keyFrom === "room" || status.keyReplicated ? (
							<p className="m-0 text-xs text-ink-3">
								{status.keyFrom === "room"
									? "Shared from another desk in this room."
									: "Shared with the other desks in this room, so any of them can send."}
							</p>
						) : null}
						{status.problems.map((problem) => (
							<p key={problem.name + problem.reason} className="m-0 text-xs text-warn">
								{problem.name} couldn't register:{" "}
								{problem.reason === "permission-denied"
									? "notifications are turned off for Toad on that phone (Settings → Toad → Notifications)."
									: problem.reason}
							</p>
						))}
						<div className="mt-2xs flex items-center gap-xs">
							<button type="button" className="btn-outline" disabled={testing} onClick={() => void test()}>
								{testing ? "Sending…" : "Send a test"}
							</button>
							<button type="button" className="btn-ghost" onClick={() => void clear()}>
								Remove key
							</button>
						</div>

						{tested && (
							<p className="m-0 text-xs text-ink-3">
								{tested.failed.length === 0 && tested.sent > 0 && (
									<span className="text-accent">
										Sent to {tested.sent} phone{tested.sent === 1 ? "" : "s"}.
									</span>
								)}
								{tested.sent === 0 && tested.failed.length === 0 && "No phone has registered yet."}
								{tested.failed.map((failure, index) => (
									<span key={index} className="block text-danger">
										{REASONS[failure.reason] ?? failure.reason}
										{REASONS[failure.reason] && (
											<span className="text-ink-3"> ({failure.reason})</span>
										)}
									</span>
								))}
							</p>
						)}
					</div>
				) : (
					<div className="flex flex-col gap-xs">
						<button type="button" className="btn-outline w-fit" onClick={() => file.current?.click()}>
							{fileName || "Choose the .p8 file…"}
						</button>
						<input
							ref={file}
							type="file"
							accept=".p8"
							hidden
							onChange={(event) => {
								const picked = event.currentTarget.files?.[0];
								event.currentTarget.value = "";
								if (!picked) return;
								setFileName(picked.name);
								setError("");
								void picked.text().then(setPem, () => setError("Couldn't read that file."));
							}}
						/>

						<div className="flex gap-xs">
							<input
								className="field flex-1 font-mono text-sm"
								placeholder="Key ID"
								value={keyId}
								onChange={(event) => setKeyId(event.target.value)}
							/>
							<input
								className="field flex-1 font-mono text-sm"
								placeholder="Team ID"
								value={teamId}
								onChange={(event) => setTeamId(event.target.value)}
							/>
						</div>

						<button
							type="button"
							className="btn-primary w-fit"
							disabled={!pem || !keyId.trim() || !teamId.trim() || installing}
							onClick={() => void install()}
						>
							{installing ? "Installing…" : "Install key"}
						</button>

						{error && <p className="m-0 text-xs text-danger">{error}</p>}
					</div>
				)}
		</Field>
	);
	/* "It never leaves this machine" was true of the key until the key started
	 * replicating, and a hint that describes the previous version of the feature
	 * is worse than none: it is the sentence someone reads while wondering why
	 * another desk sent the notification. */
	const phoneHint =
		"Toad's own desktops push to a paired phone — no second app, no third party holding a token. A phone's address is held by every desk in the room; the key that signs for it is shared only if you say so, and one desk is elected per notification so a buzz never arrives twice.";

	if (isWeb) {
		return (
			<>
				<Section
					title="On this desktop"
					hint="A toast on the machine running Toad when a teammate finishes or needs you."
				>
					{desktopSection}
				</Section>
				<Section title="On a paired phone" hint={phoneHint}>
					{master}
					{events}
					{signingKey}
					{phones}
				</Section>
			</>
		);
	}

	return (
		<>
			<Section
				title="On this desktop"
				hint="A toast on this machine when a teammate finishes or needs you — and this window is not already looking at them."
			>
				{desktopSection}
			</Section>
			<Section title="On a paired phone" hint={phoneHint}>
				{master}
			</Section>
			{events && <Section title="Notify a phone when">{events}</Section>}
			<Section title="Reach">{phones}</Section>
			<Section title="Signing key">{signingKey}</Section>
		</>
	);
}
