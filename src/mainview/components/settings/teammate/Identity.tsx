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
export type IdentityDraft = { name: string; goal: string };

/** How long "Saved" stays up: long enough to be read, short enough to leave. */
const SAVED_MS = 1600;

type Props = {
	persona: Persona;
	draft: IdentityDraft | undefined;
	/** Changes when Rename… is chosen from a menu, which takes the caret here. */
	renameNonce: number;
	onDraftChange(draft: IdentityDraft | undefined): void;
	onSave(draft: IdentityDraft): Promise<unknown>;
};

export function Identity({
	persona,
	draft,
	renameNonce,
	onDraftChange,
	onSave,
}: Props) {
	const values = draft ?? { name: persona.name, goal: persona.goal };
	const [saved, setSaved] = useState(false);
	const nameField = useRef<HTMLInputElement>(null);
	const clearSaved = useRef<ReturnType<typeof setTimeout>>(undefined);
	const dirty = values.name !== persona.name || values.goal !== persona.goal;

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
			next.name === persona.name && next.goal === persona.goal ? undefined : next,
		);
	};

	const save = async () => {
		const next = { name: values.name.trim() || persona.name, goal: values.goal };
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
