import { useEffect, useRef, useState } from "react";
import type { NotifyPrefs, PushStatus } from "../../../../shared/types";
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

	useEffect(() => {
		void api.getPushStatus().then(setStatus, () => undefined);
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
						<p className="m-0 text-xs text-ink-3">
							{status.devices === 0
								? "No paired phone has registered yet."
								: `${status.devices} paired phone${status.devices === 1 ? "" : "s"} will be notified.`}
						</p>
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
	const phoneHint =
		"Toad's own desktop pushes to a paired phone — no second app, no third party holding a token. The key signs pushes for every phone that has ever paired with this desktop; it never leaves this machine.";

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
			<Section title="Signing key">{signingKey}</Section>
		</>
	);
}
