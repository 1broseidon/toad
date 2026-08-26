import { useCallback, useEffect, useState } from "react";
import QRCode from "qrcode";
import type {
	AppSettings as Settings,
	Backend,
	WebDeviceInfo,
	WebModeStatus,
} from "../../../../shared/types";
import { api } from "../../../rpc";
import { BackendOptions } from "../../../backends";
import { Field, Section, SettingsToggle } from "../../fields";
import { Nodes } from "./Nodes";

type Props = {
	backends: Backend[];
	settings: Settings | null;
	onUpdateSettings(patch: Partial<Settings>): void;
};

function relative(ts: number): string {
	const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
	if (s < 60) return "just now";
	if (s < 3600) return `${Math.round(s / 60)}m ago`;
	if (s < 86400) return `${Math.round(s / 3600)}h ago`;
	return `${Math.round(s / 86400)}d ago`;
}

export function General({ backends, settings, onUpdateSettings }: Props) {
	const [webMode, setWebMode] = useState<WebModeStatus | null>(null);
	const [devices, setDevices] = useState<WebDeviceInfo[]>([]);
	const [pairing, setPairing] = useState<{ qr: string; code: string } | null>(null);

	const refreshDevices = useCallback(() => {
		void api.listWebDevices().then(setDevices, () => undefined);
	}, []);

	useEffect(() => {
		void api.getWebMode().then(setWebMode, () => undefined);
		refreshDevices();
	}, [refreshDevices]);

	const addDevice = useCallback(async () => {
		const { url, code } = await api.createWebPairing();
		if (!url) return;
		const qr = await QRCode.toDataURL(url, {
			width: 220,
			margin: 1,
			color: { dark: "#edeef0", light: "#040405" },
		});
		setPairing({ qr, code });
	}, []);

	/* While the QR is up, the code on screen stays claimable: codes are
	 * single-use and short-lived, so after a device links (the count grows —
	 * also how linking is visibly acknowledged) or the TTL nears, a fresh
	 * code replaces the shown one. Enrolling two devices, or Safari first
	 * and the installed app second, never means re-opening the dialog. */
	useEffect(() => {
		if (!pairing) return;
		let known = devices.length;
		const poll = setInterval(() => {
			void api.listWebDevices().then((next) => {
				setDevices(next);
				if (next.length > known) {
					known = next.length;
					void addDevice();
				}
			}, () => undefined);
		}, 2_000);
		const remint = setInterval(() => void addDevice(), 90_000);
		return () => {
			clearInterval(poll);
			clearInterval(remint);
		};
		// Deliberately not keyed on `devices`: the interval owns its own count.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [pairing !== null, addDevice]);

	const toggleWebMode = (enabled: boolean) => {
		setWebMode((current) => (current ? { ...current, enabled } : current));
		setPairing(null);
		void api.setWebMode(enabled).then(setWebMode, () => undefined);
	};

	const revoke = (id: string) => {
		void api.revokeWebDevice(id).then(refreshDevices, () => undefined);
	};

	return (
		<div className="flex flex-col gap-2xl">
		<Section title="General">
			<Field
				label="Default backend"
				hint="Used when you add a teammate without picking one. Changing it leaves existing teammates alone."
			>
				<select
					className="field"
					aria-label="Default backend"
					value={settings?.defaultBackendId ?? ""}
					disabled={settings === null}
					onChange={(event) => onUpdateSettings({ defaultBackendId: event.target.value })}
				>
					<BackendOptions backends={backends} />
				</select>
			</Field>

			<Field
				label="Chapters close after"
				hint="How long a teammate sits idle before its working context is closed as a chapter and the next message starts fresh, with a handoff note. A day of conversation suits a model; a week of it confuses one. Eight hours means a night's sleep."
			>
				<label className="flex items-center gap-xs text-sm text-ink-2">
					<input
						type="number"
						className="field w-24"
						aria-label="Idle hours before a chapter closes"
						min={1}
						max={336}
						step={1}
						value={settings?.chapterIdleHours ?? 8}
						disabled={settings === null}
						onChange={(event) => {
							const hours = Number(event.target.value);
							if (Number.isFinite(hours) && hours >= 1 && hours <= 336) {
								onUpdateSettings({ chapterIdleHours: hours });
							}
						}}
					/>
					<span>hours idle</span>
				</label>
			</Field>

			<Field
				label="Web access"
				hint="Serves the mobile app to phones on your network. Each device links once by scanning a code, holds its own credential, and can be cut loose below. LAN/VPN only."
			>
				{/* The switch and the address are one column: side by side they crowd
				  * each other, and the address is read, not operated. */}
				<div className="min-w-0">
					<SettingsToggle
						label="Serve Toad on the local network"
						checked={webMode?.enabled ?? false}
						disabled={webMode === null}
						onChange={(event) => toggleWebMode(event.target.checked)}
					/>

					{webMode?.enabled && webMode.url && (
						<p className="m-0 mt-2xs font-mono text-2xs text-ink-3">
							Phones open {webMode.url}
						</p>
					)}
				</div>
			</Field>

			{webMode?.enabled && (
				<Field
					label="Linked devices"
					hint="Phones and browsers linked to this desktop. Revoking one signs it out immediately."
				>
					{devices.length === 0 ? (
						<p className="m-0 text-xs text-ink-3">No devices linked yet.</p>
					) : (
						<ul className="flex flex-col divide-y divide-rule-2 border-y border-rule-2">
							{devices.map((device) => (
								<li key={device.id} className="flex items-center gap-sm py-xs">
									<span className="min-w-0 flex-1">
										<span className="block text-sm text-ink">{device.name}</span>
										<span className="block text-2xs text-ink-3">
											linked {relative(device.createdAt)} · seen {relative(device.lastSeenAt)}
										</span>
									</span>
									<button type="button" className="btn-outline shrink-0" onClick={() => revoke(device.id)}>
										Revoke
									</button>
								</li>
							))}
						</ul>
					)}

					{pairing ? (
						<div className="mt-sm flex flex-col items-start gap-xs">
							<img
								src={pairing.qr}
								alt="Pairing QR code"
								className="rounded-md border border-rule"
								width={220}
								height={220}
							/>
							<p className="m-0 text-xs text-ink-3">
								Scan with the phone's camera — or, in an already-installed Toad, use “Scan the
								code” on its link screen. Typing{" "}
								<span className="font-mono text-ink-2">{pairing.code}</span> works too. The code
								stays fresh while this is open, and each device that links gets a new one.
							</p>
							<button type="button" className="btn-ghost" onClick={() => setPairing(null)}>
								Done
							</button>
						</div>
					) : (
						<button type="button" className="btn-outline mt-sm" onClick={() => void addDevice()}>
							Add device
						</button>
					)}
				</Field>
			)}
		</Section>

			<Nodes />
		</div>
	);
}
