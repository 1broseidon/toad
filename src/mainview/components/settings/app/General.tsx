import type {
	AppSettings as Settings,
	Backend,
} from "../../../../shared/types";
import { BackendOptions } from "../../../backends";
import { Field, Section } from "../../fields";

type Props = {
	backends: Backend[];
	settings: Settings | null;
	onUpdateSettings(patch: Partial<Settings>): void;
};

export function General({ backends, settings, onUpdateSettings }: Props) {
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
		</Section>
	);
}
