import { useEffect, useRef, useState } from "react";
import type { Persona } from "../../../../shared/types";
import { webClient } from "../../../platform";
import { Field, Section } from "../../fields";

/**
 * An edit to a teammate's name or brief that has not been saved.
 *
 * Held above this form — by the window, per teammate — so that leaving the
 * section, or settings altogether, does not throw away unfinished typing.
 */
export type IdentityDraft = { name: string; goal: string; team?: string };

/** How long "Saved" stays up: long enough to be read, short enough to leave. */
const SAVED_MS = 1600;

type Props = {
	persona: Persona;
	/** Every team label in use — the canonical list; typos do not mint teams. */
	teams?: string[];
	draft: IdentityDraft | undefined;
	/** Changes when Rename… is chosen from a menu, which takes the caret here. */
	renameNonce: number;
	onDraftChange(draft: IdentityDraft | undefined): void;
	onSave(draft: IdentityDraft): Promise<unknown>;
};

export function Identity({
	persona,
	teams = [],
	draft,
	renameNonce,
	onDraftChange,
	onSave,
}: Props) {
	const values = draft ?? { name: persona.name, goal: persona.goal, team: persona.team ?? "" };
	const team = values.team ?? persona.team ?? "";
	const [naming, setNaming] = useState(false);
	const [saved, setSaved] = useState(false);
	const nameField = useRef<HTMLInputElement>(null);
	const clearSaved = useRef<ReturnType<typeof setTimeout>>(undefined);
	const dirty =
		values.name !== persona.name ||
		values.goal !== persona.goal ||
		(values.team ?? "") !== (persona.team ?? "");

	useEffect(() => {
		if (renameNonce === 0) return;
		nameField.current?.focus();
		nameField.current?.select();
	}, [renameNonce]);

	// Saving and then closing settings is the ordinary way out of this form, and
	// it leaves a second of confirmation still waiting to be taken back down.
	useEffect(() => () => clearTimeout(clearSaved.current), []);

	const change = (next: IdentityDraft) => {
		setSaved(false);
		onDraftChange(
			next.name === persona.name &&
				next.goal === persona.goal &&
				(next.team ?? "") === (persona.team ?? "")
				? undefined
				: next,
		);
	};

	const save = async () => {
		const next = {
			name: values.name.trim() || persona.name,
			goal: values.goal,
			team: (values.team ?? "").trim(),
		};
		await onSave(next);
		setSaved(true);
		clearTimeout(clearSaved.current);
		clearSaved.current = setTimeout(() => setSaved(false), SAVED_MS);
	};

	/* On the phone an edit saves when the field is left — there is no Save
	 * button anywhere on that screen, matching the platform's own forms. */
	const blur = () => {
		if (webClient() && dirty) void save();
	};

	return (
		<Section title="Identity">
			<Field label="Name">
				<input
					ref={nameField}
					className="field"
					aria-label="Name"
					value={values.name}
					onChange={(event) => change({ ...values, name: event.target.value })}
					onBlur={blur}
					onKeyDown={(event) => {
						if (event.key === "Enter" && dirty) void save();
					}}
				/>
			</Field>

			<Field
				label="Brief"
				hint="Written to AGENTS.md in the working directory, which is how the agent picks it up."
			>
				<textarea
					rows={8}
					className="field resize-none leading-relaxed"
					aria-label="Brief"
					placeholder="What is this teammate for? Give it a role, priorities, and any constraints."
					value={values.goal}
					onChange={(event) => change({ ...values, goal: event.target.value })}
					onBlur={blur}
				/>
			</Field>

			<Field
				label="Team"
				hint="Teams are labels, not agents: messaging a team hands the message to its next available member."
			>
				{naming ? (
					<input
						autoFocus
						className="field"
						aria-label="New team name"
						placeholder="Name the team"
						value={team}
						onChange={(event) => change({ ...values, team: event.target.value })}
						onBlur={() => {
							setNaming(false);
							blur();
						}}
						onKeyDown={(event) => {
							if (event.key === "Enter") setNaming(false);
						}}
					/>
				) : (
					<select
						className="field"
						aria-label="Team"
						value={teams.includes(team) ? team : team ? "__current" : ""}
						onChange={(event) => {
							if (event.target.value === "__new") {
								setNaming(true);
								return;
							}
							const next = { ...values, team: event.target.value };
							change(next);
							if (webClient()) {
								void onSave({
									name: next.name.trim() || persona.name,
									goal: next.goal,
									team: next.team ?? "",
								});
							}
						}}
					>
						<option value="">No team</option>
						{!teams.includes(team) && team && <option value="__current">{team}</option>}
						{teams.map((name) => (
							<option key={name} value={name}>
								{name}
							</option>
						))}
						<option value="__new">New team…</option>
					</select>
				)}
			</Field>

			{!webClient() && (
				<div className="flex items-center gap-xs">
					<button type="button" className="btn-primary" disabled={!dirty} onClick={save}>
						Save
					</button>
					{saved && <span className="text-xs text-accent">Saved</span>}
					{dirty && !saved && <span className="text-xs text-ink-3">Unsaved changes</span>}
				</div>
			)}
		</Section>
	);
}
