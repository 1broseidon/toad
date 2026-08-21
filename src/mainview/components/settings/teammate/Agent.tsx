import { isUp } from "../../../../shared/session";
import type { Backend, Persona, SessionInfo } from "../../../../shared/types";
import { BackendOptions } from "../../../backends";
import { Detail, Field, Section } from "../../fields";
import { Subagents } from "./Subagents";

type Props = {
	persona: Persona;
	backends: Backend[];
	info: SessionInfo | null;
	onSwitchBackend(backendId: string): Promise<unknown>;
	onEditSubagent(kind: string): void;
	onAddSubagent(): void;
};

export function Agent({
	persona,
	backends,
	info,
	onSwitchBackend,
	onEditSubagent,
	onAddSubagent,
}: Props) {
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
		<div className="flex flex-col gap-2xl">
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
						<Detail term={info?.modelLabel ?? "Model"} value={model} />
						<Detail term={info?.modeLabel ?? "Mode"} value={mode} />
						{(info?.configs ?? []).map((picker) => (
							<Detail
								key={picker.id}
								term={picker.name}
								value={
									picker.options.find((choice) => choice.id === picker.currentId)?.name ??
									picker.currentId ??
									"Default"
								}
							/>
						))}
					</dl>
				</Field>
			</Section>
			{persona.backendId === "pi" && (
				<Subagents
					persona={persona}
					models={info?.models ?? []}
					running={running}
					onEdit={onEditSubagent}
					onAdd={onAddSubagent}
				/>
			)}
		</div>
	);
}
