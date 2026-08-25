/* Hallmark · component: settings detail pane · genre: modern-minimal · theme: project tokens
 * states: default · hover · focus-visible · active · disabled · empty
 * contrast: pass (40–41)
 */
import { ModelOptions } from "../../../backends";
import { useEffect, useState, type InputHTMLAttributes, type TextareaHTMLAttributes } from "react";
import type { ConfigChoice, Persona, SubagentDefaults, SubagentSpec } from "../../../../shared/types";
import {
	DEFAULT_TASK_RUNNER_DESCRIPTION,
	DEFAULT_TASK_RUNNER_NAME,
	MAX_SUBAGENT_DESCRIPTION,
	MAX_SUBAGENT_EXTRAS,
	MAX_SUBAGENT_NAME,
	MAX_SUBAGENT_PROMPT,
	isLegalSubagentId,
	isReservedSubagentId,
	normalizePersonaSubagents,
	resolveSubagentRoster,
	slugifySubagentId,
} from "../../../../shared/subagents";
import { BackIcon } from "../../icons";
import { Field, Section } from "../../fields";
import { kindOfSubagentDetail, type TeammateDetailId } from "../sections";

type ListProps = {
	persona: Persona;
	models: ConfigChoice[];
	running: boolean;
	onEdit(kind: string): void;
	onAdd(): void;
};

type PaneProps = {
	persona: Persona;
	models: ConfigChoice[];
	running: boolean;
	detail: TeammateDetailId;
	onPatch(patch: Partial<Persona>): Promise<unknown>;
	onBack(): void;
};

type Draft = {
	name: string;
	id: string;
	description: string;
	prompt: string;
	modelId: string;
};

function emptyDraft(): Draft {
	return { name: "", id: "", description: "", prompt: "", modelId: "" };
}

function persist(
	next: { defaults?: SubagentDefaults; extras?: SubagentSpec[] },
	onPatch: PaneProps["onPatch"],
): void {
	void onPatch({ subagents: normalizePersonaSubagents(next) });
}

function modelLine(modelId: string | undefined, models: ConfigChoice[]): string {
	if (!modelId) return "same model";
	return models.find((model) => model.id === modelId)?.name ?? modelId;
}

/**
 * The subagents this Toad Agent teammate may send work to.
 *
 * A list, in the same shape as Linked Devices: a name, a second line, and a
 * button. Edit and add do not swap this section for a form — they open their
 * own pane, the way Configure opens Toad Agent from Agents.
 */
export function Subagents({ persona, models, running, onEdit, onAdd }: ListProps) {
	const extras = persona.subagents?.extras ?? [];
	const roster = resolveSubagentRoster(persona);

	return (
		<Section
			title="Subagents"
			hint={
				running
					? "This teammate is running. Kinds are read when a session starts, so changes apply on its next restart."
					: "The main agent can send bounded work to these. They do not speak in the chat. They belong to this teammate only."
			}
		>
			<ul className="flex flex-col divide-y divide-rule-2 border-y border-rule-2">
				{roster.map((entry) => (
					<li key={entry.id} className="flex items-center gap-sm py-xs">
						<span className="min-w-0 flex-1">
							<span className="block text-sm text-ink">{entry.name}</span>
							<span className="block text-2xs text-ink-3">
								{entry.id}
								{" · "}
								{modelLine(entry.modelId, models)}
							</span>
						</span>
						<button type="button" className="btn-outline shrink-0" onClick={() => onEdit(entry.id)}>
							Edit
						</button>
					</li>
				))}
			</ul>

			{extras.length < MAX_SUBAGENT_EXTRAS && (
				<button type="button" className="btn-outline mt-sm" onClick={onAdd}>
					Add subagent
				</button>
			)}
		</Section>
	);
}

/**
 * One subagent, as its own settings pane.
 *
 * Reached from the Agent list, so it opens with a way back rather than
 * replacing the list under the same heading. The task runner can be changed
 * here; extras can be deleted. Creating one lands back on the list.
 */
export function SubagentPane({ persona, models, running, detail, onPatch, onBack }: PaneProps) {
	const defaults = persona.subagents?.defaults ?? {};
	const extras = persona.subagents?.extras ?? [];
	const roster = resolveSubagentRoster(persona);
	const creating = detail === "subagent-new";
	const kind = kindOfSubagentDetail(detail);
	const editing = kind ? roster.find((entry) => entry.id === kind) : undefined;

	const [adding, setAdding] = useState<Draft>(emptyDraft);
	const [idTouched, setIdTouched] = useState(false);

	const saveDefaults = (patch: SubagentDefaults) => {
		persist({ defaults: { ...defaults, ...patch }, extras }, onPatch);
	};

	const saveExtras = (next: SubagentSpec[]) => {
		persist({ defaults, extras: next }, onPatch);
	};

	const taken = new Set(extras.map((extra) => extra.id));

	const commitAdd = () => {
		const name = adding.name.trim();
		if (!name) return;
		const wanted = adding.id.trim() || slugifySubagentId(name);
		if (isReservedSubagentId(wanted) || !isLegalSubagentId(wanted) || taken.has(wanted)) return;
		saveExtras([
			...extras,
			{
				id: wanted,
				name,
				description: adding.description.trim() || DEFAULT_TASK_RUNNER_DESCRIPTION,
				...(adding.prompt.trim() ? { prompt: adding.prompt.trim() } : {}),
				...(adding.modelId.trim() ? { modelId: adding.modelId.trim() } : {}),
			},
		]);
		onBack();
	};

	const title = creating ? "New subagent" : (editing?.name ?? "Subagent");
	const name = creating
		? adding.name
		: editing?.builtin
			? (defaults.name ?? "")
			: (editing?.name ?? "");
	const description = creating
		? adding.description
		: editing?.builtin
			? (defaults.description ?? "")
			: (editing?.description ?? "");
	const prompt = creating ? adding.prompt : (editing?.prompt ?? "");
	const modelId = creating ? adding.modelId : (editing?.modelId ?? "");

	return (
		<div className="flex flex-col gap-2xl">
			<div>
				<button type="button" className="btn-ghost -ml-3xs gap-2xs !px-xs" onClick={onBack}>
					<BackIcon />
					<span>Agent</span>
				</button>
				<p className="mt-xs max-w-prose text-xs leading-relaxed text-ink-3">
					{running
						? "This teammate is running. Kinds are read when a session starts, so changes apply on its next restart."
						: creating
							? "A silent runner for this teammate only. Kind is locked after you add it."
							: "A silent runner for this teammate only. It does not speak in the chat."}
				</p>
			</div>

			<Section title={title}>
				<Field label="Name">
					<CommitInput
						className="field"
						aria-label={`${title} name`}
						placeholder={editing?.builtin ? DEFAULT_TASK_RUNNER_NAME : "Reviewer"}
						value={name}
						maxLength={MAX_SUBAGENT_NAME}
						immediate={creating}
						onCommit={(value) => {
							if (creating) {
								setAdding((current) => ({
									...current,
									name: value,
									id: idTouched ? current.id : slugifySubagentId(value),
								}));
								return;
							}
							if (editing?.builtin) {
								saveDefaults({ name: value.trim() || undefined });
								return;
							}
							if (!editing) return;
							saveExtras(
								extras.map((extra) =>
									extra.id === editing.id ? { ...extra, name: value.trim() || extra.name } : extra,
								),
							);
						}}
					/>
				</Field>
				<Field
					label="Kind"
					hint={
						creating
							? "What the main agent passes as kind. Locked after you add it."
							: "What the main agent passes as kind."
					}
				>
					{creating ? (
						<input
							className="field font-mono text-2xs"
							aria-label="Subagent kind"
							value={adding.id}
							maxLength={40}
							onChange={(event) => {
								setIdTouched(true);
								setAdding((current) => ({ ...current, id: event.target.value }));
							}}
						/>
					) : (
						<p className="m-0 font-mono text-2xs text-ink-2">{editing?.id}</p>
					)}
				</Field>
				<Field label="When to use">
					<CommitTextarea
						className="field min-h-16 resize-y leading-relaxed"
						aria-label={`${title} when to use`}
						placeholder={DEFAULT_TASK_RUNNER_DESCRIPTION}
						value={description}
						maxLength={MAX_SUBAGENT_DESCRIPTION}
						immediate={creating}
						onCommit={(value) => {
							if (creating) {
								setAdding((current) => ({ ...current, description: value }));
								return;
							}
							const trimmed = value.trim();
							if (editing?.builtin) {
								saveDefaults({ description: trimmed || undefined });
								return;
							}
							if (!editing) return;
							saveExtras(
								extras.map((extra) =>
									extra.id === editing.id
										? { ...extra, description: trimmed || DEFAULT_TASK_RUNNER_DESCRIPTION }
										: extra,
								),
							);
						}}
					/>
				</Field>
				<Field label="Instructions" hint="Optional. Appended to the silent-runner briefing.">
					<CommitTextarea
						className="field min-h-16 resize-y leading-relaxed"
						aria-label={`${title} instructions`}
						value={prompt}
						maxLength={MAX_SUBAGENT_PROMPT}
						immediate={creating}
						onCommit={(value) => {
							if (creating) {
								setAdding((current) => ({ ...current, prompt: value }));
								return;
							}
							const trimmed = value.trim();
							if (editing?.builtin) {
								saveDefaults({ prompt: trimmed || undefined });
								return;
							}
							if (!editing) return;
							saveExtras(
								extras.map((extra) =>
									extra.id === editing.id
										? trimmed
											? { ...extra, prompt: trimmed }
											: { ...extra, prompt: undefined }
										: extra,
								),
							);
						}}
					/>
				</Field>
				<Field label="Model">
					<ModelSelect
						value={modelId}
						models={models}
						onChange={(next) => {
							if (creating) {
								setAdding((current) => ({ ...current, modelId: next ?? "" }));
								return;
							}
							if (editing?.builtin) {
								saveDefaults({ modelId: next });
								return;
							}
							if (!editing) return;
							saveExtras(
								extras.map((extra) =>
									extra.id === editing.id
										? next
											? { ...extra, modelId: next }
											: { ...extra, modelId: undefined }
										: extra,
								),
							);
						}}
					/>
				</Field>
				{creating && adding.id && taken.has(adding.id) && (
					<p className="text-xs text-ink-3">That kind is already used on this teammate.</p>
				)}
				{creating && adding.id && isReservedSubagentId(adding.id) && (
					<p className="text-xs text-ink-3">generic is reserved for the task runner.</p>
				)}
				<div className="flex flex-wrap justify-end gap-xs">
					{editing && !editing.builtin && (
						<button
							type="button"
							className="btn-outline"
							onClick={() => {
								saveExtras(extras.filter((extra) => extra.id !== editing.id));
								onBack();
							}}
						>
							Delete
						</button>
					)}
					{creating && (
						<button
							type="button"
							className="btn-primary"
							disabled={
								!adding.name.trim() ||
								isReservedSubagentId(adding.id.trim() || slugifySubagentId(adding.name)) ||
								!isLegalSubagentId(adding.id.trim() || slugifySubagentId(adding.name)) ||
								taken.has(adding.id.trim() || slugifySubagentId(adding.name))
							}
							onClick={commitAdd}
						>
							Add
						</button>
					)}
				</div>
			</Section>
		</div>
	);
}

function CommitInput({
	value,
	onCommit,
	immediate,
	...props
}: InputHTMLAttributes<HTMLInputElement> & {
	value: string;
	immediate?: boolean;
	onCommit(value: string): void;
}) {
	const [local, setLocal] = useState(value);
	useEffect(() => setLocal(value), [value]);
	return (
		<input
			{...props}
			value={local}
			onChange={(event) => {
				const next = event.target.value;
				setLocal(next);
				if (immediate) onCommit(next);
			}}
			onBlur={() => {
				if (!immediate && local !== value) onCommit(local);
			}}
		/>
	);
}

function CommitTextarea({
	value,
	onCommit,
	immediate,
	...props
}: TextareaHTMLAttributes<HTMLTextAreaElement> & {
	value: string;
	immediate?: boolean;
	onCommit(value: string): void;
}) {
	const [local, setLocal] = useState(value);
	useEffect(() => setLocal(value), [value]);
	return (
		<textarea
			{...props}
			value={local}
			onChange={(event) => {
				const next = event.target.value;
				setLocal(next);
				if (immediate) onCommit(next);
			}}
			onBlur={() => {
				if (!immediate && local !== value) onCommit(local);
			}}
		/>
	);
}

function ModelSelect({
	value,
	models,
	onChange,
}: {
	value: string;
	models: ConfigChoice[];
	onChange(modelId: string | undefined): void;
}) {
	if (models.length === 0) {
		return (
			<input
				className="field font-mono text-2xs"
				aria-label="Model"
				placeholder="Same as this teammate (provider/id)"
				value={value}
				onChange={(event) => onChange(event.target.value.trim() || undefined)}
			/>
		);
	}

	const known = !value || models.some((model) => model.id === value);
	return (
		<select
			className="field"
			aria-label="Model"
			value={value}
			onChange={(event) => onChange(event.target.value || undefined)}
		>
			<option value="">Same as this teammate</option>
			{!known && value && <option value={value}>{value}</option>}
			<ModelOptions models={models} />
		</select>
	);
}
