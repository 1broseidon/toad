import type {
	DeskCapabilities,
	DeskCapabilityInfo,
	HarnessChoice,
	HarnessResolution,
} from "../../shared/types";
import { DEFAULT_BACKEND_ID, listBackends } from "../acp/registry";
import { currentRoom } from "../node/room";
import { getRecord, localNodeId, putLocal } from "../store/records";
import { resolveHarness } from "./ladder";
import { peerOnline } from "./wire";

/**
 * Capability advertisement: each desk tells the room what it can actually run.
 *
 * The advertisement is a `desk` record keyed by the node's own id, so it rides
 * the same first-hand sync personas do — shipped on link-up, re-shipped only
 * when it changed, and durable on every member. A peer going dark therefore
 * leaves its last-known advertisement readable, marked by when the owner last
 * wrote it; the record store is the memory, not the wire.
 *
 * Nothing secret leaves. The harness list carries id/name/available — the
 * same truth `listBackends` computes for the Other Agents pane, adapter-is-
 * not-the-agent rule included — and the built-in agent's reach is provider
 * and model ids with an authenticated boolean. No tokens, no key material,
 * no filesystem paths.
 */

/**
 * What this desk can run, computed fresh.
 *
 * The pi side is imported on demand and forgiven on failure for the same
 * reason `index.ts` imports `./pi/auth` on demand: a runtime that cannot load
 * the built-in agent's tree (a verify harness, an ACP-only launch) still has
 * honest ACP availability to advertise, with the built-in agent shown as
 * unauthenticated rather than the whole advertisement missing.
 */
export async function computeDeskCapabilities(): Promise<DeskCapabilities> {
	const backends = await listBackends();
	return {
		platform: process.platform,
		arch: process.arch,
		harnesses: backends.map((backend) => ({
			id: backend.id,
			name: backend.name,
			available: backend.available,
		})),
		builtin: await builtinReach(),
		capturedAt: Date.now(),
	};
}

async function builtinReach(): Promise<DeskCapabilities["builtin"]> {
	/* Verify harnesses stub the built-in agent's reach, the way TOAD_PI_AUTH_PATH
	 * stubs its credentials file: a child that only exercises the advertisement
	 * plane must not spend real network auth checks — or read real logins — to
	 * have something to advertise. Not user-facing. */
	const stub = process.env.TOAD_CAPS_BUILTIN_STUB;
	if (stub) {
		const parsed = JSON.parse(stub) as DeskCapabilities["builtin"];
		return {
			authenticated: parsed.authenticated === true,
			providers: Array.isArray(parsed.providers) ? parsed.providers : [],
			models: Array.isArray(parsed.models) ? parsed.models : [],
		};
	}
	try {
		const [{ listProviderAuth }, { availableModels }] = await Promise.all([
			import("../pi/auth"),
			import("../pi/runtime"),
		]);
		const providers = (await listProviderAuth())
			.filter((provider) => provider.configured)
			.map((provider) => provider.id);
		const models = (await availableModels()).map((model) => model.id);
		return { authenticated: providers.length > 0, providers, models };
	} catch {
		return { authenticated: false, providers: [], models: [] };
	}
}

let refreshing: Promise<void> | undefined;

/**
 * Recomputes this desk's advertisement and writes it only when it changed.
 *
 * `capturedAt` is excluded from the comparison on purpose: it moves on every
 * compute, and a version bump per compute would make an idle desk chatter its
 * unchanged capabilities to the whole room. Concurrent callers coalesce onto
 * one in-flight refresh — the settings pane and the periodic sweep asking at
 * once is one probe, not two.
 */
export function refreshDeskCapabilities(): Promise<void> {
	if (refreshing) return refreshing;
	refreshing = (async () => {
		const fresh = await computeDeskCapabilities();
		const current = getRecord("desk", localNodeId());
		if (!current?.deleted && current) {
			const { capturedAt: _fresh, ...next } = fresh;
			const { capturedAt: _held, ...held } = current.replicated as DeskCapabilities;
			if (JSON.stringify(next) === JSON.stringify(held)) return;
		}
		putLocal("desk", localNodeId(), { replicated: fresh as unknown as Record<string, unknown> });
	})().finally(() => {
		refreshing = undefined;
	});
	return refreshing;
}

/** How long a capability drift (an install, an env change) may go unnoticed. */
const REFRESH_SWEEP_MS = 5 * 60_000;

/**
 * First advertisement plus the slow sweep. Event-driven refreshes (a login,
 * a logout, the Other Agents pane probing) come from their own call sites;
 * the sweep only bounds how stale a quiet desk's advertisement can get.
 */
export function initDeskCapabilities(): void {
	void refreshDeskCapabilities().catch(() => {});
	setInterval(() => void refreshDeskCapabilities().catch(() => {}), REFRESH_SWEEP_MS);
}

/**
 * One desk's advertisement as known here — this desk's own, a live peer's, or
 * the last-known word of a dark one, marked stale so a caller can say which.
 */
export function deskCapabilities(nodeId?: string): DeskCapabilityInfo | null {
	const id = nodeId ?? localNodeId();
	const record = getRecord("desk", id);
	if (!record || record.deleted) return null;
	const capabilities = capabilitiesOf(record.replicated);
	if (!capabilities) return null;
	const online = id === localNodeId() || peerOnline(id);
	return { nodeId: id, capabilities, heardAt: record.updatedAt, online, stale: !online };
}

/** A replicated payload as a capabilities value, or nothing when malformed. */
function capabilitiesOf(value: Record<string, unknown>): DeskCapabilities | null {
	const candidate = value as Partial<DeskCapabilities>;
	if (typeof candidate.platform !== "string" || !Array.isArray(candidate.harnesses)) return null;
	const builtin = candidate.builtin;
	return {
		platform: candidate.platform,
		arch: typeof candidate.arch === "string" ? candidate.arch : "",
		harnesses: candidate.harnesses
			.filter(
				(entry): entry is { id: string; name: string; available: boolean } =>
					typeof entry?.id === "string" &&
					typeof entry?.name === "string" &&
					typeof entry?.available === "boolean",
			)
			.map((entry) => ({ id: entry.id, name: entry.name, available: entry.available })),
		builtin: {
			authenticated: builtin?.authenticated === true,
			providers: strings(builtin?.providers),
			models: strings(builtin?.models),
		},
		capturedAt: typeof candidate.capturedAt === "number" ? candidate.capturedAt : 0,
	};
}

function strings(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

/**
 * The ladder, asked about one teammate and one destination desk.
 *
 * Answerable on any member without a wire: the teammate's harness, model and
 * override are replicated persona fields, the room default is the replicated
 * room record, and the destination's capabilities are its replicated
 * advertisement. A qualified persona id (`nodeId/personaId`) names the same
 * record its bare tail does, so both spellings work.
 */
export function resolveTeammateHarness(
	personaId: string,
	targetNodeId: string,
): { ok: true; resolution: HarnessResolution; desk: DeskCapabilityInfo } | { ok: false; error: string } {
	const bare = personaId.slice(personaId.lastIndexOf("/") + 1);
	const record = getRecord("persona", bare);
	if (!record || record.deleted) return { ok: false, error: `No teammate ${bare}` };
	const replicated = record.replicated as {
		backendId?: unknown;
		modelId?: unknown;
		harnessOverride?: unknown;
	};

	const desk = deskCapabilities(targetNodeId);
	if (!desk) {
		return { ok: false, error: "That desk has not advertised its capabilities yet" };
	}

	const current: HarnessChoice = {
		backendId:
			typeof replicated.backendId === "string" && replicated.backendId.length > 0
				? replicated.backendId
				: DEFAULT_BACKEND_ID,
		...(typeof replicated.modelId === "string" && replicated.modelId.length > 0
			? { modelId: replicated.modelId }
			: {}),
	};
	const override = harnessOf(replicated.harnessOverride);
	const roomDefault = currentRoom()?.defaultHarness;

	return {
		ok: true,
		resolution: resolveHarness({
			current,
			...(override ? { override } : {}),
			...(roomDefault ? { roomDefault } : {}),
			destination: desk.capabilities,
		}),
		desk,
	};
}

function harnessOf(value: unknown): HarnessChoice | undefined {
	const candidate = value as Partial<HarnessChoice> | undefined;
	if (typeof candidate?.backendId !== "string" || candidate.backendId.length === 0) {
		return undefined;
	}
	return {
		backendId: candidate.backendId,
		...(typeof candidate.modelId === "string" && candidate.modelId.length > 0
			? { modelId: candidate.modelId }
			: {}),
	};
}
