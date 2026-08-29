import { isUp } from "../../../../shared/session";
import type { Backend, Persona, SessionInfo } from "../../../../shared/types";
import { BackendOptions, ModelOptions } from "../../../backends";
import { Detail, Field, Section } from "../../fields";
import { Subagents } from "./Subagents";

type Props = {
	persona: Persona;
	backends: Backend[];
	info: SessionInfo | null;
	onSwitchBackend(backendId: string): Promise<unknown>;
	onEditSubagent(kind: string): void;
	onAddSubagent(): void;
	/**
	 * Present only on the phone, where this pane is the disposition's one home
	 * and so must set it, not just read it. The desktop leaves this out — its
	 * pickers live in the toolbar, and this pane stays a report there.
	 */
	live?: {
		onSetModel(modelId: string): void;
		onSetMode(modeId: string): void;
		onSetConfig(configId: string, value: string): void;
	};
};

export function Agent({
	persona,
	backends,
	info,
	onSwitchBackend,
	onEditSubagent,
	onAddSubagent,
	live,
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

				{live && running && info ? (
					/* The pickers are the platform's own selects, the same control
					 * the Backend field above uses — switchable only while the
					 * session is live, because that is when there is an agent to
					 * re-dispose. */
					<>
						{info.models.length > 0 && (
							<Field label={info.modelLabel ?? "Model"}>
								<select
									className="field"
									aria-label={info.modelLabel ?? "Model"}
									value={info.currentModelId ?? ""}
									onChange={(event) => live.onSetModel(event.target.value)}
								>
									<ModelOptions models={info.models} />
								</select>
							</Field>
						)}
						{info.modes.length > 0 && (
							<Field label={info.modeLabel ?? "Mode"}>
								<select
									className="field"
									aria-label={info.modeLabel ?? "Mode"}
									value={info.currentModeId ?? ""}
									onChange={(event) => live.onSetMode(event.target.value)}
								>
									{info.modes.map((choice) => (
										<option key={choice.id} value={choice.id}>
											{choice.name}
										</option>
									))}
								</select>
							</Field>
						)}
						{(info.configs ?? []).map((picker) => (
							<Field key={picker.id} label={picker.name}>
								<select
									className="field"
									aria-label={picker.name}
									value={picker.currentId ?? ""}
									onChange={(event) => live.onSetConfig(picker.id, event.target.value)}
								>
									{picker.options.map((choice) => (
										<option key={choice.id} value={choice.id}>
											{choice.name}
										</option>
									))}
								</select>
							</Field>
						))}
					</>
				) : (
					<Field
						label="Disposition"
						hint={live ? "Set while the session is running — a message wakes it." : undefined}
					>
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
				)}
				{live && info?.agentVersion && (
					<Field label="Version">
						<p className="m-0 text-xs text-ink-3">{info.agentVersion}</p>
					</Field>
				)}
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
