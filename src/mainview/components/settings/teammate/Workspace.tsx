import { useEffect, useState } from "react";
import type { Backend, Containment, FleetPeerInfo, NodeIdentity, Persona } from "../../../../shared/types";
import { api } from "../../../rpc";
import { webClient } from "../../../platform";
import { Field, PathRow, Section } from "../../fields";

type Props = {
	persona: Persona;
	backends: Backend[];
	containment: Containment | null;
	running: boolean;
	/** A turn is actually happening. Running only means the harness is up. */
	busy: boolean;
	onPatch(patch: Partial<Persona>): Promise<unknown>;
	onPickWorkspace(): Promise<string | null>;
	onReveal(): void;
};

export function Workspace({
	persona,
	backends,
	containment,
	running,
	busy,
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
					{!webClient() && (
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
					)}
				</PathRow>
			</Field>

			<DeskField persona={persona} busy={busy} />

			<Field label="Approvals">
				<Approvals containment={containment} backend={backendLabel(backends, persona.backendId)} />
			</Field>
		</Section>
	);
}

/**
 * Which desk the teammate lives on, and the way to another one. One teammate,
 * one tape: a hop moves the whole conversation, and the refusal — busy, owner
 * dark, nothing there can run it — comes back in words. Rendered only when the
 * room has somewhere to hop to.
 */
function DeskField({ persona, busy }: { persona: Persona; busy: boolean }) {
	const [peers, setPeers] = useState<FleetPeerInfo[] | null>(null);
	const [home, setHome] = useState<NodeIdentity | null>(null);
	const [moving, setMoving] = useState(false);
	const [note, setNote] = useState<string | null>(null);

	useEffect(() => {
		setNote(null);
		void api.fleetPeers().then(setPeers, () => setPeers([]));
		void api.nodeInfo().then(setHome, () => setHome(null));
	}, [persona.id]);

	if (!peers || peers.length === 0 || !home) return null;
	const owner = persona.node ?? { id: home.id, name: "this desk" };
	const destinations = [
		...(persona.node ? [{ id: home.id, name: `${home.name} (this desk)` }] : []),
		...peers.filter((peer) => peer.id !== owner.id).map((peer) => ({ id: peer.id, name: peer.name })),
	];
	if (destinations.length === 0) return null;

	return (
		<Field
			label="Desk"
			hint="Moving takes the whole teammate — tape, goal, and ownership — to the other desk. It starts fresh there on whatever agent that desk can run."
		>
			<div className="flex flex-col gap-2xs">
				<p className="text-xs text-ink-2">Lives on {owner.name}.</p>
				<div className="flex flex-wrap gap-2xs">
					{destinations.map((desk) => (
						<button
							key={desk.id}
							type="button"
							className="btn-outline"
							/* A running harness is not a busy one. The hop stops an idle
							 * session itself; only a turn in flight is worth waiting on,
							 * and the refusal comes back in words if it starts one. */
							disabled={busy || moving}
							onClick={() => {
								setMoving(true);
								setNote(null);
								void api
									.hopTeammate(persona.id, desk.id)
									.then((result) =>
										setNote(result.ok ? `Moved to ${desk.name}.` : result.error),
									)
									.catch((error) =>
										setNote(error instanceof Error ? error.message : "The hop failed"),
									)
									.finally(() => setMoving(false));
							}}
						>
							{moving ? "Moving…" : `Move to ${desk.name}`}
						</button>
					))}
				</div>
				{note && <p className="text-xs leading-relaxed text-ink-3">{note}</p>}
			</div>
		</Field>
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
