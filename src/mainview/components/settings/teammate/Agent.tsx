import type { Backend, Persona, SessionInfo } from "../../../../shared/types";
import { Detail, Field, Section } from "../../fields";

type Props = {
	persona: Persona;
	backends: Backend[];
	info: SessionInfo | null;
	onPatch(patch: Partial<Persona>): Promise<unknown>;
};

export function Agent({ persona, backends, info, onPatch }: Props) {
	const running = info?.state === "ready" || info?.state === "thinking";
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
			<Field label="Backend" hint={running ? "Restart the session to change this." : undefined}>
				<select
					className="field"
					aria-label="Backend"
					value={persona.backendId}
					disabled={running}
					onChange={(event) => void onPatch({ backendId: event.target.value })}
				>
					{backends.map((backend) => (
						<option key={backend.id} value={backend.id} disabled={!backend.available}>
							{backend.name}
							{backend.available ? "" : ` — ${backend.unavailableReason ?? "not installed"}`}
						</option>
					))}
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
