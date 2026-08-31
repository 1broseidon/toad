import type { StreamCursor } from "../store/streams";
import { localNodeId } from "../store/records";
import { installedPlugin, pluginState } from "./host";
import {
	appendPluginLog,
	initPluginLogPlane,
	openPluginLog,
	pluginLogReach,
	pluginLogSource,
	pluginLogStreamId,
	readPluginLog,
	MAX_APPEND_BYTES,
} from "./log-plane";
import { notifyPlugin } from "./notify";
import { pluginMay, type PluginVerdict } from "./permission";
import { answerCursors, applyDelta, applyReset } from "../fleet/stream-replication";

/**
 * The plugin's side of the node plane: the log frames on the wire, the events,
 * and the four gates every inbound frame passes.
 *
 * Everything a plugin does on the fleet rides Toad's own plane. The plugin
 * never imports `fleet/wire`, never holds a `NodeLink`, never sees a `linkKey`.
 * That is what makes the refusal and the first-hand stamp enforceable rather
 * than advisory: the rejected alternative — a second socket carrying raw frames
 * — hands the plugin author the room's own failure detector, and a plugin that
 * blocks or floods then takes down the mesh.
 *
 * The gates, on the receiving desk, in order, each naming a desk, a plugin and
 * a cause:
 *
 *   1. an authenticated admitted NodeLink peer — already true before we run
 *   2. `plugin_absent` — "beastie does not have board"
 *   3. `refused` — this install does not accept this kind from this peer
 *   4. `plugin_down` / `not_granted` — installed, but not in a state or with a
 *      grant that answers
 *
 * The sending side asks the same function about its own scope before touching
 * the wire, so a plugin cannot discover its grants by watching refusals arrive.
 */

/** The fleet modules, reached lazily — the house idiom for this cycle
 *  (`fleet/fleet.ts:822`), because the fleet imports this file. */
type WireFacade = typeof import("../fleet/wire");
type FleetFacade = typeof import("../fleet/fleet");
type CapabilitiesFacade = typeof import("../fleet/capabilities");

function wire(): WireFacade {
	return require("../fleet/wire") as WireFacade;
}
function fleet(): FleetFacade {
	return require("../fleet/fleet") as FleetFacade;
}
function capabilities(): CapabilitiesFacade {
	return require("../fleet/capabilities") as CapabilitiesFacade;
}

/** The push name every plugin event travels under. One name, id as a field. */
export const PLUGIN_EVENT_PUSH = "plugin.event";

/* ------------------------------------------------------------------- desks */

export type PluginDeskRow = {
	nodeId: string;
	name: string;
	self: boolean;
	/** A live authenticated wire right now. False for this desk's own row is a lie
	 *  nobody wants, so `self` is linked by definition. */
	linked: boolean;
	/** Its advertisement is last-known rather than current. */
	stale: boolean;
	plugins: Array<{ id: string; version: string }>;
};

/**
 * The room as a plugin may see it: names, reachability and installed plugins.
 * Never the raw stores, and nothing about credentials, paths or models.
 */
export function pluginDesks(): PluginDeskRow[] {
	const self = localNodeId();
	const rows: PluginDeskRow[] = [];
	const mine = capabilities().deskCapabilities(self);
	rows.push({
		nodeId: self,
		name: "this desk",
		self: true,
		linked: true,
		stale: false,
		plugins: (mine?.capabilities.plugins ?? []).map((entry) => ({
			id: entry.id,
			version: entry.version,
		})),
	});
	for (const peer of fleet().listFleetPeers()) {
		const desk = capabilities().deskCapabilities(peer.id);
		rows.push({
			nodeId: peer.id,
			name: peer.name,
			self: false,
			linked: wire().peerOnline(peer.id),
			stale: desk?.stale ?? true,
			plugins: (desk?.capabilities.plugins ?? []).map((entry) => ({
				id: entry.id,
				version: entry.version,
			})),
		});
	}
	return rows;
}

/** Which desks advertise one plugin, by node id. The log plane's expectation set. */
export function desksWithPlugin(pluginId: string): string[] {
	return pluginDesks()
		.filter((row) => !row.self && row.plugins.some((entry) => entry.id === pluginId))
		.map((row) => row.nodeId);
}

/* ------------------------------------------------------------------ scopes */

function scopeOf(pluginId: string, fromNode?: string, fromNodeName?: string) {
	const manifest = installedPlugin(pluginId);
	return {
		pluginId,
		...(manifest ? { manifest } : {}),
		...(pluginState(pluginId) ? { state: pluginState(pluginId)! } : {}),
		...(fromNode ? { fromNode } : {}),
		...(fromNodeName ? { fromNodeName } : {}),
	};
}

/** The local plugin's own permission to do a thing, before the wire is touched. */
export function localMay(
	pluginId: string,
	action: Parameters<typeof pluginMay>[1],
	target: string,
): PluginVerdict {
	return pluginMay(scopeOf(pluginId), action, target);
}

/* ------------------------------------------------------------------- logs */

export type LogOpenResult = { gen: number; offset: number; streamId: string };

export function openLog(pluginId: string, logId: string): LogOpenResult | PluginVerdict {
	const verdict = localMay(pluginId, "fleet.log", logId);
	if (!verdict.allowed) return verdict;
	const { gen, offset } = openPluginLog(pluginId, logId);
	return { gen, offset, streamId: pluginLogStreamId(pluginId, logId) };
}

export function appendLog(
	pluginId: string,
	logId: string,
	bytes: Uint8Array,
): { gen: number; offset: number; size: number } | PluginVerdict {
	const verdict = localMay(pluginId, "fleet.log", logId);
	if (!verdict.allowed) return verdict;
	if (bytes.length > MAX_APPEND_BYTES) {
		return {
			allowed: false,
			code: "not_granted",
			reason: `one line may be ${MAX_APPEND_BYTES} bytes and this one is ${bytes.length}; bytes are not what a log carries`,
		};
	}
	return appendPluginLog(pluginId, logId, bytes);
}

/**
 * Who is writing this log, and whose writing this desk can see.
 *
 * The two are different questions and the gap between them is the honest
 * answer to "is my fold complete". `mirrors` is what arrived; `absent` names
 * every desk that advertises the plugin and whose bytes are not here, so a
 * fold can say "showing 3 of 4 writers" instead of quietly showing 3.
 */
export function logCursors(pluginId: string, logId: string) {
	const verdict = localMay(pluginId, "fleet.log", logId);
	if (!verdict.allowed) return verdict;
	const reach = pluginLogReach(pluginId, logId);
	const held = new Set(reach.mirrors.map((entry) => entry.nodeId));
	const absent = pluginDesks()
		.filter((row) => !row.self && row.plugins.some((entry) => entry.id === pluginId))
		.filter((row) => !held.has(row.nodeId))
		.map((row) => ({
			nodeId: row.nodeId,
			name: row.name,
			reason: row.linked
				? `${row.name} runs ${pluginId} and has shipped nothing of "${logId}" yet`
				: `${row.name} is not reachable from here, so its "${logId}" is not held`,
		}));
	return { ...reach, absent };
}

export function readLog(input: {
	pluginId: string;
	logId: string;
	ownerNode: string;
	gen: number;
	from: number;
	len: number;
}) {
	const verdict = localMay(input.pluginId, "fleet.log", input.logId);
	if (!verdict.allowed) return verdict;
	return readPluginLog(input);
}

/* ------------------------------------------------------------------ events */

export type EmitResult = { delivered: string[]; missed: string[] };

/**
 * Fire and forget, and say exactly who it went to.
 *
 * `broadcastNodeLinks` answers with one aggregate boolean, which is not a
 * truth a plugin can build on: "some desk got it" and "the desk you care about
 * got it" are different facts. Loss here is total and permanent — a dark desk
 * misses the event and there is no store-and-forward anywhere in this tree —
 * so the API names the misses rather than implying delivery on reconnect.
 */
export function emitEvent(input: {
	pluginId: string;
	name: string;
	payload: Record<string, unknown>;
	to?: string[];
}): EmitResult | PluginVerdict {
	const verdict = localMay(input.pluginId, "fleet.events", input.name);
	if (!verdict.allowed) return verdict;
	const targets =
		input.to && input.to.length > 0
			? input.to
			: fleet()
					.listFleetPeers()
					.map((peer) => peer.id);
	const delivered: string[] = [];
	const missed: string[] = [];
	for (const nodeId of targets) {
		if (nodeId === localNodeId()) continue;
		const sent = wire().pushToNode(nodeId, PLUGIN_EVENT_PUSH, {
			pluginId: input.pluginId,
			name: input.name,
			payload: input.payload,
		});
		(sent ? delivered : missed).push(nodeId);
	}
	return { delivered, missed };
}

/**
 * An event arriving from another desk.
 *
 * `from` is stamped here, from the authenticated peer id, and is a sibling of
 * the payload rather than a field inside it. A plugin therefore has no way to
 * assert provenance and cannot become a relay for unsigned assertions — the
 * manifest validator already refuses a payload schema that declares `from`,
 * `src`, `desk` or `node`, so the mistake is unmakeable rather than merely
 * caught.
 */
export function receivePluginEvent(nodeId: string, nodeName: string, payload: unknown): void {
	const input = payload as {
		pluginId?: unknown;
		name?: unknown;
		payload?: unknown;
	} | null;
	if (!input || typeof input.pluginId !== "string" || typeof input.name !== "string") return;
	const verdict = pluginMay(
		scopeOf(input.pluginId, nodeId, nodeName),
		"fleet.events",
		input.name,
	);
	if (!verdict.allowed) return;
	notifyPlugin(input.pluginId, PLUGIN_EVENT_PUSH, {
		from: nodeId,
		fromName: nodeName,
		name: input.name,
		payload: (input.payload ?? {}) as Record<string, unknown>,
	});
}

/* --------------------------------------------------------------- the wire */

/**
 * The one `plugin` fleet method, dispatched by a `kind` field.
 *
 * `FLEET_METHODS` gains exactly one entry for the whole plugin system and the
 * plugin's identity is a parameter, never part of the method name. `wire.ts`
 * resolves `peerMethod(...) ?? resolveLocal(...)` and `resolveLocal` is the
 * entire app RPC handler map, so the peer method namespace is already flat and
 * already global: a `plugin:<id>/<method>` string is one typo from shadowing
 * `updateAppSettings`. A field cannot be.
 */
export async function handlePluginPeerCall(
	peer: { id: string; name: string },
	params: unknown,
): Promise<unknown> {
	const input = params as { pluginId?: unknown; kind?: unknown; body?: unknown } | null;
	if (!input || typeof input.pluginId !== "string" || typeof input.kind !== "string") {
		throw new Error("plugin call needs pluginId and kind");
	}
	const pluginId = input.pluginId;
	const body = (input.body ?? {}) as Record<string, unknown>;

	if (!installedPlugin(pluginId)) {
		return {
			ok: false,
			code: "plugin_absent",
			reason: `this desk does not have ${pluginId}`,
		};
	}

	switch (input.kind) {
		case "log.cursors": {
			const cursors = (body.cursors ?? {}) as Record<string, StreamCursor>;
			const gate = gateLogFrames(pluginId, peer, Object.keys(cursors));
			if (gate) return gate;
			return answerCursors(peer.id, pluginLogSource(), cursors);
		}
		case "log.delta": {
			const streamId = typeof body.streamId === "string" ? body.streamId : "";
			const gen = body.gen;
			const offset = body.offset;
			const data = body.data;
			if (
				!streamId ||
				!Number.isInteger(gen) ||
				!Number.isInteger(offset) ||
				(offset as number) < 0 ||
				typeof data !== "string"
			) {
				throw new Error("bad plugin log delta");
			}
			const gate = gateLogFrames(pluginId, peer, [streamId]);
			if (gate) return gate;
			const applied = applyDelta(
				peer.id,
				streamId,
				gen as number,
				offset as number,
				Buffer.from(data, "base64"),
				"plugin.log.delta",
			);
			if (applied.ok) notifyPlugin(pluginId, "plugin.log.changed", { streamId, from: peer.id });
			return applied;
		}
		case "log.reset": {
			const streamId = typeof body.streamId === "string" ? body.streamId : "";
			const gen = body.gen;
			if (!streamId || !Number.isInteger(gen)) throw new Error("bad plugin log reset");
			const gate = gateLogFrames(pluginId, peer, [streamId]);
			if (gate) return gate;
			applyReset(peer.id, streamId, gen as number, "plugin.log.reset");
			notifyPlugin(pluginId, "plugin.log.changed", { streamId, from: peer.id, reset: true });
			return { ok: true };
		}
		default:
			return { ok: false, code: "not_declared", reason: `unknown plugin frame "${input.kind}"` };
	}
}

/**
 * Whether this desk's install accepts these log frames from this peer.
 *
 * Every stream in the frame must be one this install was granted, so a peer
 * cannot use a plugin both desks hold to push a log only one of them declared.
 */
function gateLogFrames(
	pluginId: string,
	peer: { id: string; name: string },
	streamIds: string[],
): { ok: false; code: string; reason: string } | null {
	for (const streamId of streamIds) {
		const logId = logIdOf(pluginId, streamId);
		if (logId === null) {
			return {
				ok: false,
				code: "not_declared",
				reason: `"${streamId}" is not a log of ${pluginId}`,
			};
		}
		const verdict = pluginMay(scopeOf(pluginId, peer.id, peer.name), "fleet.log", logId);
		if (!verdict.allowed) return { ok: false, code: verdict.code, reason: verdict.reason };
	}
	return null;
}

function logIdOf(pluginId: string, streamId: string): string | null {
	const prefix = `plugin:${pluginId}/`;
	if (!streamId.startsWith(prefix)) return null;
	const logId = streamId.slice(prefix.length);
	return logId.length > 0 ? logId : null;
}

/* ------------------------------------------------------------------- boot */

let started = false;

/** Registers the plugin log source. Idempotent; safe before any plugin exists. */
export function initPluginFleet(): void {
	if (started) return;
	started = true;
	initPluginLogPlane({
		grantedLogs: (pluginId) => installedPlugin(pluginId)?.grants.fleet.log ?? [],
		pluginsOn: (nodeId) =>
			(capabilities().deskCapabilities(nodeId)?.capabilities.plugins ?? []).map(
				(entry) => entry.id,
			),
		call: (link, pluginId, kind, body) => link.call("plugin", { pluginId, kind, body }),
	});
}
