import { useEffect, useState } from "react";
import type {
	AppSettings as Settings,
	Backend,
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

export function General({ backends, settings, onUpdateSettings }: Props) {
	const [webMode, setWebMode] = useState<WebModeStatus | null>(null);

	useEffect(() => {
		void api.getWebMode().then(setWebMode, () => undefined);
	}, []);

	const toggleWebMode = (enabled: boolean) => {
		setWebMode((current) => (current ? { ...current, enabled } : current));
		void api.setWebMode(enabled).then(setWebMode, () => undefined);
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
				hint="Serves the app to browsers on your network — open the address on your phone. The link carries a private token; anyone with it can drive your teammates, so share it like a password. LAN/VPN only: nothing is exposed beyond networks you're on."
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
					<input
						readOnly
						aria-label="Web access address"
						className="field mt-xs w-full font-mono text-2xs text-ink-2"
						value={webMode.url}
						onFocus={(event) => event.target.select()}
					/>
				)}
			</Field>
		</Section>
	);
}
