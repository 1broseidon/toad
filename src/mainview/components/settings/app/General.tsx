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
import { Field, Section } from "../../fields";

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

	// A new phone shows up in the list moments after it scans; poll gently
	// while the QR is on screen so linking is visibly acknowledged.
	useEffect(() => {
		if (!pairing) return;
		const timer = setInterval(refreshDevices, 2_000);
		return () => clearInterval(timer);
	}, [pairing, refreshDevices]);

	const toggleWebMode = (enabled: boolean) => {
		setWebMode((current) => (current ? { ...current, enabled } : current));
		setPairing(null);
		void api.setWebMode(enabled).then(setWebMode, () => undefined);
	};

	const addDevice = async () => {
		const { url, code } = await api.createWebPairing();
		if (!url) return;
		const qr = await QRCode.toDataURL(url, {
			width: 220,
			margin: 1,
			color: { dark: "#edeef0", light: "#040405" },
		});
		setPairing({ qr, code });
	};

	const revoke = (id: string) => {
		void api.revokeWebDevice(id).then(refreshDevices, () => undefined);
	};

	return (
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
				label="Web access"
				hint="Serves the mobile app to phones on your network. Each device links once by scanning a code, holds its own credential, and can be cut loose below. LAN/VPN only."
			>
				<label className="flex items-center gap-xs text-sm text-ink-2">
					<input
						type="checkbox"
						checked={webMode?.enabled ?? false}
						disabled={webMode === null}
						onChange={(event) => toggleWebMode(event.target.checked)}
					/>
					<span>Serve Toad on the local network</span>
				</label>

				{webMode?.enabled && webMode.url && (
					<p className="m-0 mt-2xs font-mono text-2xs text-ink-3">
						Phones open {webMode.url}
					</p>
				)}
			</Field>

			{webMode?.enabled && (
				<Field
					label="Linked devices"
					hint="Revoking a device signs it out immediately — its next screen is the link prompt."
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
								Scan with the phone's camera, or open the address above and type{" "}
								<span className="font-mono text-ink-2">{pairing.code}</span>. The code lives for
								two minutes.
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
	);
}
