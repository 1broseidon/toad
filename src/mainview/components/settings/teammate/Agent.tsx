import { isUp } from "../../../../shared/session";
import type { Backend, Persona, SessionInfo } from "../../../../shared/types";
import { BackendOptions } from "../../../backends";
import { Detail, Field, Section } from "../../fields";

type Props = {
	persona: Persona;
	backends: Backend[];
	info: SessionInfo | null;
	onSwitchBackend(backendId: string): Promise<unknown>;
};

export function Agent({ persona, backends, info, onSwitchBackend }: Props) {
	const running = info ? isUp(info.state) : false;
	const model =
		info?.models.find((choice) => choice.id === info.currentModelId)?.name ??
		info?.currentModelId ??
		"Default";
	const mode =
		info?.modes.find((choice) => choice.id === info.currentModeId)?.name ??
		info?.currentModeId ??
		"Default";

	return (
		<Section title="Agent">
			<Field
				label="Backend"
				hint={running ? "The current session will restart." : undefined}
			>
				<select
					className="field"
					aria-label="Backend"
					value={persona.backendId}
					onChange={(event) => void onSwitchBackend(event.target.value)}
				>
					<BackendOptions backends={backends} />
				</select>
			</Field>

			<Field label="Disposition">
				<dl className="flex flex-col gap-3xs text-xs text-ink-3">
					<Detail term="Model" value={model} />
					<Detail term="Mode" value={mode} />
				</dl>
			</Field>
		</Section>
	);
}
