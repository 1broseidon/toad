import type { Backend, Containment, Persona } from "../../../../shared/types";
import { Field, PathRow, Section } from "../../fields";

type Props = {
	persona: Persona;
	backends: Backend[];
	containment: Containment | null;
	running: boolean;
	onPatch(patch: Partial<Persona>): Promise<unknown>;
	onPickWorkspace(): Promise<string | null>;
	onReveal(): void;
};

export function Workspace({
	persona,
	backends,
	containment,
	running,
	onPatch,
	onPickWorkspace,
	onReveal,
}: Props) {
	return (
		<Section title="Workspace">
			<Field
				label="Working directory"
				hint="The agent starts here, but this is not a boundary. It can still reach the rest of the machine."
			>
				<PathRow label="Working directory" path={persona.cwd} onReveal={onReveal}>
					<button
						type="button"
						className="btn-outline shrink-0"
						disabled={running}
						onClick={async () => {
							const picked = await onPickWorkspace();
							if (picked) await onPatch({ cwd: picked });
						}}
					>
						Change
					</button>
				</PathRow>
			</Field>

			<Field label="Approvals">
				<Approvals containment={containment} backend={backendLabel(backends, persona.backendId)} />
			</Field>
		</Section>
	);
}

/**
 * Whether this backend will stop and ask before it acts.
 *
 * This used to arrive in the conversation as a warning on every session start,
 * which was noise: it is a fact about how the machine is set up, it does not
 * change while you are talking, and it belongs next to the working directory it
 * qualifies. Unknown is stated as unknown — Toad can read Cursor's approval
 * setting and no one else's, and a reassuring guess here would be worse than
 * none.
 */
function Approvals({ containment, backend }: { containment: Containment | null; backend: string }) {
	if (containment === null) return <p className="text-xs text-ink-3">Checking…</p>;

	if (!containment.known) {
		return (
			<p className="text-xs leading-relaxed text-ink-3">
				Toad cannot tell whether {backend} asks before it acts — that setting lives in {backend}
				&rsquo;s own configuration, in a format Toad does not read. If it is set to approve
				everything, Toad never gets the chance to ask you.
			</p>
		);
	}

	return (
		<div className="flex flex-col gap-2xs text-xs leading-relaxed">
			<p className={containment.asksPermission ? "text-ink-2" : "text-warn"}>
				{containment.asksPermission
					? `${backend} asks before it acts, and Toad shows you the request.`
					: `${backend} is set to approve everything itself, so Toad never gets to ask you.`}
			</p>
			{containment.sandboxed === false && (
				<p className="text-ink-3">Its sandbox is off, so file and command access is unrestricted.</p>
			)}
			{containment.configPath && (
				<p className="font-mono text-2xs text-ink-3">{containment.configPath}</p>
			)}
		</div>
	);
}

function backendLabel(backends: Backend[], id: string): string {
	return backends.find((backend) => backend.id === id)?.name ?? id;
}
