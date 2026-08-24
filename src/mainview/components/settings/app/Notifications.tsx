import { useEffect, useRef, useState } from "react";
import type { PushStatus } from "../../../../shared/types";
import { api } from "../../../rpc";
import { Field, Section } from "../../fields";

/**
 * Push notifications: the key that lets this desktop sign for Apple, and
 * which moments are worth a buzz.
 *
 * The `.p8` never touches this component's state as anything but a file the
 * browser read — it goes to bun over the RPC the moment the form submits and
 * is never held here afterward. See docs/push.md for what it unlocks and why
 * the payload stays a doorbell rather than a transport.
 */

type Kind = "turnEnded" | "permission" | "blocked";

const KINDS: Array<{ id: Kind; label: string; hint: string }> = [
	{ id: "turnEnded", label: "A teammate finishes", hint: "The turn you sent ended and it's ready for you." },
	{ id: "permission", label: "A teammate needs you", hint: "A permission, or something it asked you to do by hand." },
	{ id: "blocked", label: "A teammate gets stuck", hint: "It stopped on an error." },
];

export function Notifications({
	push,
	onUpdatePush,
}: {
	push: { enabled: boolean; turnEnded?: boolean; permission?: boolean; blocked?: boolean } | undefined;
	onUpdatePush(patch: Partial<NonNullable<typeof push>>): void;
}) {
	const [status, setStatus] = useState<PushStatus | null>(null);
	const [installing, setInstalling] = useState(false);
	const [error, setError] = useState("");
	const [keyId, setKeyId] = useState("");
	const [teamId, setTeamId] = useState("");
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
	};

	const enabled = push?.enabled ?? false;

	return (
		<Section
			title="Notifications"
			hint="Toad's own desktop pushes to a paired phone — no second app, no third party holding a token. The key signs pushes for every phone that has ever paired with this desktop; it never leaves this machine."
		>
			<Field label="Notify a paired phone">
				<label className="flex items-center gap-xs text-sm text-ink-2">
					<input
						type="checkbox"
						checked={enabled}
						disabled={status === null}
						onChange={(event) => onUpdatePush({ enabled: event.target.checked })}
					/>
					<span>Send push notifications</span>
				</label>
			</Field>

			{enabled &&
				KINDS.map((kind) => (
					<Field key={kind.id} label={kind.label} hint={kind.hint}>
						<label className="flex items-center gap-xs text-sm text-ink-2">
							<input
								type="checkbox"
								checked={push?.[kind.id] !== false}
								onChange={(event) => onUpdatePush({ [kind.id]: event.target.checked })}
							/>
							<span>Notify</span>
						</label>
					</Field>
				))}

			<Field
				label="Signing key"
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
						<button type="button" className="btn-outline mt-2xs w-fit" onClick={() => void clear()}>
							Remove key
						</button>
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
		</Section>
	);
}
