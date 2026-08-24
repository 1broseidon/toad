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
import { resolveSubagentRoster } from "../../../shared/subagents";
import {
	isSubagentDetail,
	kindOfSubagentDetail,
	subagentDetail,
	type TeammateDetailId,
	type TeammateSectionId,
} from "./sections";
import { Agent } from "./teammate/Agent";
import { Danger } from "./teammate/Danger";
import { Identity, type IdentityDraft } from "./teammate/Identity";
import { Schedule } from "./teammate/Schedule";
import { Session } from "./teammate/Session";
import { SubagentPane } from "./teammate/Subagents";
import { Tools } from "./teammate/Tools";
import { Workspace } from "./teammate/Workspace";

/**
 * What is true of one teammate: who it is, what drives it, where it works.
 *
 * Only reachable with a teammate in hand, which is why it takes one rather than
 * a nullable — the overlay does that check once, at the door.
 */

type Props = {
	/** Every team label in use, for the Identity picker. */
	teams?: string[];
	section: TeammateSectionId;
	detail: TeammateDetailId | undefined;
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
	onOpenDetail(detail: TeammateDetailId): void;
	onCloseDetail(): void;
};

export function TeammatePane({
	teams,
	section,
	detail,
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
	onOpenDetail,
	onCloseDetail,
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

	/* The editor is a real pane. If the kind is gone — backend left Toad
	 * Agent, or this teammate no longer has that extra — there is nothing
	 * to show, so land back on Agent rather than an empty form. */
	useEffect(() => {
		if (section !== "agent" || !isSubagentDetail(detail)) return;
		if (persona.backendId !== "pi") {
			onCloseDetail();
			return;
		}
		const kind = kindOfSubagentDetail(detail);
		if (kind && !resolveSubagentRoster(persona).some((entry) => entry.id === kind)) {
			onCloseDetail();
		}
	}, [section, detail, persona, onCloseDetail]);

	switch (section) {
		case "identity":
			return (
				<Identity
					persona={persona}
					teams={teams}
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
			return isSubagentDetail(detail) ? (
				<SubagentPane
					persona={persona}
					models={info?.models ?? []}
					running={info ? isUp(info.state) : false}
					detail={detail}
					onPatch={onPatch}
					onBack={onCloseDetail}
				/>
			) : (
				<Agent
					persona={persona}
					backends={backends}
					info={info}
					onSwitchBackend={onSwitchBackend}
					onEditSubagent={(kind) => onOpenDetail(subagentDetail(kind))}
					onAddSubagent={() => onOpenDetail("subagent-new")}
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
			return <Session info={info} personaId={persona.id} />;
		case "danger":
			return <Danger onDelete={onDelete} />;
	}
}
