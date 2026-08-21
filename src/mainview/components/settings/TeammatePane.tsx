import { useEffect, useState } from "react";
import { isUp } from "../../../shared/session";
import type {
	Backend,
	Containment,
	McpServerConfig,
	Persona,
	SessionInfo,
} from "../../../shared/types";
import { api } from "../../rpc";
import type { TeammateSectionId } from "./sections";
import { Agent } from "./teammate/Agent";
import { Danger } from "./teammate/Danger";
import { Identity, type IdentityDraft } from "./teammate/Identity";
import { Schedule } from "./teammate/Schedule";
import { Session } from "./teammate/Session";
import { Tools } from "./teammate/Tools";
import { Workspace } from "./teammate/Workspace";

/**
 * What is true of one teammate: who it is, what drives it, where it works.
 *
 * Only reachable with a teammate in hand, which is why it takes one rather than
 * a nullable — the overlay does that check once, at the door.
 */

type Props = {
	section: TeammateSectionId;
	persona: Persona;
	backends: Backend[];
	info: SessionInfo | null;
	renameNonce: number;
	identityDraft: IdentityDraft | undefined;
	onIdentityDraftChange(personaId: string, draft: IdentityDraft | undefined): void;
	onPatch(patch: Partial<Persona>): Promise<unknown>;
	onSwitchBackend(backendId: string): Promise<unknown>;
	onDelete(): void;
	onPickWorkspace(): Promise<string | null>;
	onRevealWorkspace(): void;
};

export function TeammatePane({
	section,
	persona,
	backends,
	info,
	renameNonce,
	identityDraft,
	onIdentityDraftChange,
	onPatch,
	onSwitchBackend,
	onDelete,
	onPickWorkspace,
	onRevealWorkspace,
}: Props) {
	const [containment, setContainment] = useState<Containment | null>(null);
	const [servers, setServers] = useState<McpServerConfig[] | null>(null);

	/* The teammate's tools are a choice about app-wide servers, so this pane
	 * needs the app's list. Read when Tools is opened rather than with the
	 * teammate: most visits here never look at it, and a server added in the
	 * other pane should be there when this one is opened again. */
	useEffect(() => {
		if (section !== "tools") return;
		let cancelled = false;
		void api.getAppSettings().then((settings) => {
			if (!cancelled) setServers(settings.mcpServers);
		});
		return () => {
			cancelled = true;
		};
	}, [section]);

	/* Read once per teammate/backend pair rather than when Workspace mounts.
	 * Section visits are navigation, not a request to re-read an external file. */
	useEffect(() => {
		let cancelled = false;
		setContainment(null);
		void api.getContainment(persona.backendId).then((next) => {
			if (!cancelled) setContainment(next);
		});
		return () => {
			cancelled = true;
		};
	}, [persona.id, persona.backendId]);

	switch (section) {
		case "identity":
			return (
				<Identity
					persona={persona}
					draft={identityDraft}
					renameNonce={renameNonce}
					onDraftChange={(draft) => onIdentityDraftChange(persona.id, draft)}
					onSave={async (draft) => {
						await onPatch({ name: draft.name.trim() || persona.name, goal: draft.goal });
						onIdentityDraftChange(persona.id, undefined);
					}}
				/>
			);
		case "agent":
			return (
				<Agent
					persona={persona}
					backends={backends}
					info={info}
					onSwitchBackend={onSwitchBackend}
				/>
			);
		case "tools":
			return (
				<Tools
					persona={persona}
					servers={servers}
					running={info ? isUp(info.state) : false}
					onPatch={onPatch}
				/>
			);
		case "schedule":
			return <Schedule personaId={persona.id} />;
		case "workspace":
			return (
				<Workspace
					persona={persona}
					backends={backends}
					containment={containment}
					running={info ? isUp(info.state) : false}
					onPatch={onPatch}
					onPickWorkspace={onPickWorkspace}
					onReveal={onRevealWorkspace}
				/>
			);
		case "session":
			return <Session info={info} />;
		case "danger":
			return <Danger onDelete={onDelete} />;
	}
}
