import type { PluginManifest, PluginReachRow, PluginState } from "../../shared/types";

/**
 * The one place a question about what a plugin may do is answered.
 *
 * There are three readers and there will always be three readers: the gate in
 * the proxy that refuses a tool call, the pane that lists what a plugin may
 * reach, and the grant dialog that previews an install nobody has agreed to
 * yet. task-31's one non-negotiable, learned the hard way on 2026-08-29 when a
 * system prompt promised tools an allowlist had silently stripped, is that
 * those three cannot be three implementations — prediction that can drift from
 * enforcement will drift, and the drift is invisible until it is a lie in a
 * system prompt.
 *
 * So this function takes its facts rather than fetching them. The pane passes
 * the installed manifest and its live state; the dialog passes a manifest that
 * is not installed and the state it would have; the gate passes both from the
 * registry. One decision, three callers, no second copy.
 *
 * Policy itself is deliberately thin in v1: the manifest's grants, agreed to at
 * install, are the whole policy. task-31 will put a room-level model above
 * this. It goes above it — this signature is what that phase extends, and the
 * shape is chosen so it can.
 */

export type PluginAction =
	| "tool.call"
	| "tool.subagentInherit"
	| "room.desks"
	| "room.teammates"
	| "fleet.log"
	| "fleet.rpc.call"
	| "fleet.rpc.serve"
	| "fleet.events"
	| "fleet.blobs";

/**
 * Why a refusal happened, so the refusal is distinguishable rather than merely
 * negative. `unreachable` belongs to the link and never originates here.
 */
export type PluginRefusal =
	| "allowed"
	| "plugin_absent"
	| "plugin_down"
	| "not_granted"
	| "not_declared"
	| "refused";

export type PluginVerdict = {
	allowed: boolean;
	code: PluginRefusal;
	/** Names a plugin and a cause. Required, like every other reason in this tree. */
	reason: string;
};

export type PluginScope = {
	pluginId: string;
	/**
	 * The manifest to judge against. Absent means the plugin is not installed
	 * here, which is itself an answer — `plugin_absent`, "beastie does not have
	 * board" — rather than a lookup failure.
	 */
	manifest?: PluginManifest;
	/** Its live state. Absent is treated as `installed`: agreed to, not running. */
	state?: PluginState;
	/** The teammate on whose behalf the plugin is being asked, when there is one. */
	personaId?: string;
	/** For an inbound fleet request, the authenticated desk it came from. */
	fromNode?: string;
	/** That desk's name, for a refusal a person can read. */
	fromNodeName?: string;
};

function no(code: PluginRefusal, reason: string): PluginVerdict {
	return { allowed: false, code, reason };
}

function yes(reason: string): PluginVerdict {
	return { allowed: true, code: "allowed", reason };
}

/** Whether an inbound request from this desk is accepted by this install. */
function acceptsFrom(scope: PluginScope): PluginVerdict | null {
	if (!scope.fromNode) return null;
	const accept = scope.manifest!.grants.acceptFrom;
	const who = scope.fromNodeName ?? scope.fromNode;
	if (accept === "none") {
		return no("refused", `${scope.pluginId} on this desk accepts nothing from other desks`);
	}
	if (Array.isArray(accept) && !accept.includes(scope.fromNode)) {
		return no("refused", `${scope.pluginId} on this desk does not accept requests from ${who}`);
	}
	return null;
}

export function pluginMay(
	scope: PluginScope,
	action: PluginAction,
	target: string,
): PluginVerdict {
	const manifest = scope.manifest;
	if (!manifest) {
		return no("plugin_absent", `${scope.pluginId} is not installed on this desk`);
	}
	const state: PluginState = scope.state ?? "installed";

	const refusedPeer = acceptsFrom(scope);
	if (refusedPeer) return refusedPeer;

	switch (action) {
		case "tool.call": {
			const tool = manifest.tools.find((entry) => entry.name === target);
			if (!tool) {
				return no(
					"not_declared",
					`${manifest.name} does not declare a tool named "${target}"; the manifest is the authoritative list`,
				);
			}
			if (state !== "running") {
				return no(
					"plugin_down",
					`${manifest.name} is installed but ${state === "failed" ? "failed and is restarting" : state}, so "${target}" cannot run`,
				);
			}
			return yes(`${manifest.name} declares "${target}" and is running`);
		}
		case "tool.subagentInherit": {
			const tool = manifest.tools.find((entry) => entry.name === target);
			if (!tool) {
				return no("not_declared", `${manifest.name} does not declare a tool named "${target}"`);
			}
			return tool.subagentInherits
				? yes(`${manifest.name} declares "${target}" as inherited by subagents`)
				: no(
						"not_granted",
						`${manifest.name} declares "${target}" as not inherited by subagents`,
					);
		}
		case "room.desks":
		case "room.teammates": {
			const want = action === "room.desks" ? "desks" : "teammates";
			return manifest.grants.room.includes(want)
				? yes(`${manifest.name} was granted room.${want}`)
				: no("not_granted", `${manifest.name} was not granted room.${want}`);
		}
		case "fleet.log":
			return manifest.grants.fleet.log.includes(target)
				? yes(`${manifest.name} owns the log "${target}"`)
				: no("not_granted", `${manifest.name} was not granted the log "${target}"`);
		case "fleet.rpc.call":
			return manifest.grants.fleet.rpc.call
				? yes(`${manifest.name} was granted fleet RPC calls`)
				: no("not_granted", `${manifest.name} was not granted fleet RPC calls`);
		case "fleet.rpc.serve":
			return manifest.grants.fleet.rpc.serve.includes(target)
				? yes(`${manifest.name} serves the method "${target}"`)
				: no("not_granted", `${manifest.name} was not granted the method "${target}"`);
		case "fleet.events":
			return manifest.grants.fleet.events
				? yes(`${manifest.name} was granted fleet events`)
				: no("not_granted", `${manifest.name} was not granted fleet events`);
		case "fleet.blobs":
			return manifest.grants.fleet.blobs
				? yes(`${manifest.name} was granted the blob store`)
				: no("not_granted", `${manifest.name} was not granted the blob store`);
	}
}

/**
 * "What may this plugin reach", drawn by asking the same function enforcement
 * asks. Every rung is reported whether it matched or not, so an absence in the
 * pane is a stated no rather than a missing line.
 */
export function pluginReach(scope: PluginScope): PluginReachRow[] {
	const manifest = scope.manifest;
	const rows: PluginReachRow[] = [];
	const ask = (action: PluginAction, target: string) => {
		const verdict = pluginMay(scope, action, target);
		rows.push({ action, target, allowed: verdict.allowed, reason: verdict.reason });
	};
	ask("room.desks", "");
	ask("room.teammates", "");
	ask("fleet.rpc.call", "");
	ask("fleet.events", "");
	ask("fleet.blobs", "");
	for (const logId of manifest?.logs ?? []) ask("fleet.log", logId);
	for (const method of manifest?.rpc.serves ?? []) ask("fleet.rpc.serve", method);
	return rows;
}
