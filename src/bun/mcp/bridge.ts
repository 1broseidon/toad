import { randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { TEAMMATE_MESSAGE_MAX_LENGTH } from "../../shared/peers";
import type {
	ChapterSummary,
	Persona,
	ScheduledJob,
	SessionInfo,
	ThreadSearchHit,
} from "../../shared/types";
import { requestHuman as requestHumanAction } from "../computer/handoff";
import { bridgeSocketPath, ensureLayout, threadKey } from "../paths";
import { getPersona, listPersonas } from "../store/personas";
import { notePick, picksFor } from "../store/teams";
import {
	deliverToPeer,
	fleetRosters,
	parseRemoteTarget,
	remoteTargetId,
} from "../fleet/fleet";
import * as threads from "../store/threads";
import * as transcript from "../store/transcript";
import {
	BRIDGE_VERSION,
	MAX_FRAME_BYTES,
	failure,
	flushFrames,
	isRequest,
	sendFrame,
	success,
	type BridgeErrorCode,
	type BridgeRequest,
	type BridgeResponse,
	type BridgeScope,
	type Chain,
	type Outbox,
} from "./protocol";

type SupervisorLike = {
	info(personaId: string): SessionInfo;
};

type SchedulerLike = {
	list(personaId?: string): ScheduledJob[];
	schedule(personaId: string, when: string, prompt: string): ScheduledJob;
	loop(personaId: string, every: string, prompt: string): ScheduledJob;
	cancel(id: string, personaId?: string): boolean;
};

type DeliverResult =
	| { ok: true; from: string; reply: string; note?: string }
	| { ok: false; reason: BridgeErrorCode; detail: string };

type PeersLike = {
	deliver(input: {
		callerId: string;
		targetId: string;
		message: string;
		chain: Chain;
	}): Promise<DeliverResult>;
	activeDelivery(key: string): Chain | undefined;
};

type ChaptersLike = {
	search(personaId: string, query: string, limit: number): { hits: ThreadSearchHit[]; truncated: boolean };
	list(personaId: string): ChapterSummary[];
	resume(personaId: string): { ok: true; title: string } | { ok: false; reason: string; detail: string };
	startFresh(personaId: string, by: "agent"): Promise<{ title?: string }>;
};

type ConnectionState = Outbox & {
	buffer: string;
	scope?: BridgeScope;
	inflight: number;
};

let activeBridge: Bridge | undefined;

export function registerBridgeScope(token: string, scope: BridgeScope): void {
	activeBridge?.register(token, scope);
}

export function revokeBridgeScope(token: string): void {
	activeBridge?.revoke(token);
}

/**
 * Call a teammate tool in this process.
 *
 * The ACP path reaches the same handlers over the unix socket, because the
 * sidecar is a child. Toad Agent is already here, so it skips the socket and
 * still authenticates with the session's token — same methods, same scope
 * rules, no extra process.
 */
export async function invokeBridge(
	token: string,
	method: string,
	params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	if (!activeBridge) {
		throw Object.assign(new Error("The Toad bridge is not running"), { code: "internal" });
	}
	return activeBridge.invoke(token, method, params);
}

/** Returns the socket path only while this process owns a live bridge. */
export function bridgeAttachmentEnabled(): string | undefined {
	return activeBridge?.socketPath;
}

function sameToken(left: string, right: string): boolean {
	const a = Buffer.from(left);
	const b = Buffer.from(right);
	return a.length === b.length && timingSafeEqual(a, b);
}

function text(value: unknown, max: number): string | undefined {
	return typeof value === "string" && value.length <= max ? value : undefined;
}

function integer(value: unknown, fallback: number, min: number, max: number): number | undefined {
	const resolved = value === undefined ? fallback : value;
	return Number.isInteger(resolved) && Number(resolved) >= min && Number(resolved) <= max
		? Number(resolved)
		: undefined;
}

function peerSessionKey(scope: Extract<BridgeScope, { kind: "peer" }>): string {
	return `${scope.threadKey}|${scope.callerId}->${scope.targetId}`;
}

export class Bridge {
	private tokens = new Map<string, BridgeScope>();
	private listener?: Bun.UnixSocketListener<ConnectionState>;
	readonly socketPath = bridgeSocketPath();

	constructor(
		private dependencies: {
			supervisor: SupervisorLike;
			peers: PeersLike;
			scheduler: SchedulerLike;
			chapters: ChaptersLike;
			/** The react tool's hands — see reactAsAgent in index.ts. */
			react: (personaId: string, emoji: string) => { on: string } | { error: string };
		},
	) {}

	async start(): Promise<boolean> {
		ensureLayout();
		if (existsSync(this.socketPath)) {
			if (await this.probeLiveOwner()) return false;
			try {
				unlinkSync(this.socketPath);
			} catch {
				return false;
			}
		}
		try {
			this.listener = Bun.listen<ConnectionState>({
				unix: this.socketPath,
				data: { buffer: "", inflight: 0, outbox: null },
				socket: {
					open(socket) {
						socket.data = { buffer: "", inflight: 0, outbox: null };
					},
					data: (socket, bytes) => this.onData(socket, bytes),
					drain: (socket) => flushFrames(socket),
					error: (socket) => socket.terminate(),
				},
			});
			activeBridge = this;
			return true;
		} catch {
			return false;
		}
	}

	register(token: string, scope: BridgeScope): void {
		if (activeBridge === this) this.tokens.set(token, scope);
	}

	revoke(token: string): void {
		this.tokens.delete(token);
	}

	async invoke(
		token: string,
		method: string,
		params: Record<string, unknown>,
	): Promise<Record<string, unknown>> {
		const match = [...this.tokens.entries()].find(([candidate]) => sameToken(candidate, token));
		if (!match) {
			throw Object.assign(new Error("Authentication failed"), { code: "unauthenticated" });
		}
		let response: BridgeResponse;
		try {
			response = await this.dispatch(0, method, params, match[1]);
		} catch {
			throw Object.assign(new Error("The bridge could not complete the request"), {
				code: "internal",
			});
		}
		if (response.ok) return response.result;
		throw Object.assign(new Error(response.error.message), { code: response.error.code });
	}

	stop(): void {
		this.tokens.clear();
		this.listener?.stop(true);
		this.listener = undefined;
		if (activeBridge === this) activeBridge = undefined;
		if (existsSync(this.socketPath)) {
			try {
				unlinkSync(this.socketPath);
			} catch {
				// Shutdown is best-effort; the next start probes before removing it.
			}
		}
	}

	private async probeLiveOwner(): Promise<boolean> {
		return new Promise<boolean>((resolve) => {
			let settled = false;
			const finish = (value: boolean) => {
				if (settled) return;
				settled = true;
				resolve(value);
			};
			const timer = setTimeout(() => finish(false), 300);
			void Bun.connect<{ buffer: string }>({
				unix: this.socketPath,
				data: { buffer: "" },
				socket: {
					open(socket) {
						socket.write(
							`${JSON.stringify({
								v: BRIDGE_VERSION,
								id: 1,
								method: "hello",
								params: { token: "probe" },
							})}\n`,
						);
					},
					data(socket, bytes) {
						socket.data.buffer += bytes.toString();
						const line = socket.data.buffer.split("\n")[0];
						if (!line) return;
						try {
							const frame = JSON.parse(line) as Partial<BridgeResponse>;
							finish(frame.v === BRIDGE_VERSION && frame.id === 1 && typeof frame.ok === "boolean");
						} catch {
							finish(false);
						}
						clearTimeout(timer);
						socket.end();
					},
					connectError() {
						clearTimeout(timer);
						finish(false);
					},
					error() {
						clearTimeout(timer);
						finish(false);
					},
				},
			}).catch(() => finish(false));
		});
	}

	private onData(socket: Bun.Socket<ConnectionState>, bytes: Buffer): void {
		socket.data.buffer += bytes.toString("utf8");
		if (!socket.data.buffer.includes("\n") && Buffer.byteLength(socket.data.buffer) > MAX_FRAME_BYTES) {
			socket.terminate();
			return;
		}
		for (;;) {
			const newline = socket.data.buffer.indexOf("\n");
			if (newline === -1) return;
			const line = socket.data.buffer.slice(0, newline);
			socket.data.buffer = socket.data.buffer.slice(newline + 1);
			if (Buffer.byteLength(line) > MAX_FRAME_BYTES) {
				socket.terminate();
				return;
			}
			let raw: unknown;
			try {
				raw = JSON.parse(line);
			} catch {
				sendFrame(socket, `${JSON.stringify(failure(0, "bad_params", "Invalid bridge frame"))}\n`);
				continue;
			}
			if (!isRequest(raw)) {
				sendFrame(socket, `${JSON.stringify(failure(0, "bad_params", "Invalid bridge frame"))}\n`);
				continue;
			}
			if (!socket.data.scope && raw.method !== "hello") {
				socket.end(`${JSON.stringify(failure(raw.id, "unauthenticated", "Authentication required"))}\n`);
				return;
			}
			if (socket.data.inflight >= 4) {
				sendFrame(socket, `${JSON.stringify(failure(raw.id, "busy", "Too many requests"))}\n`);
				continue;
			}
			socket.data.inflight++;
			void this.handle(raw, socket.data)
				.then((response) => {
					const encoded = `${JSON.stringify(response)}\n`;
					if (raw.method === "hello" && !response.ok) socket.end(encoded);
					else sendFrame(socket, encoded);
				})
				.finally(() => {
					socket.data.inflight--;
				});
		}
	}

	private async handle(request: BridgeRequest, connection: ConnectionState): Promise<BridgeResponse> {
		try {
			if (request.method === "hello") {
				if (connection.scope) return failure(request.id, "bad_params", "Already authenticated");
				const supplied = text(request.params.token, 128);
				const match = supplied
					? [...this.tokens.entries()].find(([token]) => sameToken(token, supplied))
					: undefined;
				if (!match) return failure(request.id, "unauthenticated", "Authentication failed");
				connection.scope = match[1];
				const persona = getPersona(match[1].personaId);
				return success(request.id, {
					personaId: match[1].personaId,
					name: persona?.name ?? "Unknown teammate",
					scope: match[1].kind,
				});
			}

			const scope = connection.scope;
			if (!scope) return failure(request.id, "unauthenticated", "Authentication required");
			return await this.dispatch(request.id, request.method, request.params, scope);
		} catch {
			return failure(request.id, "internal", "The bridge could not complete the request");
		}
	}

	private async dispatch(
		id: number,
		method: string,
		params: Record<string, unknown>,
		scope: BridgeScope,
	): Promise<BridgeResponse> {
		switch (method) {
			case "get_context":
				return this.getContext(id, scope);
			case "list_teammates":
				return this.listTeammates(id, scope);
			case "message_teammate":
				return await this.messageTeammate(id, scope, params);
			case "read_agent_thread":
				return this.readAgentThread(id, scope, params);
			case "read_transcript":
				return this.readTranscript(id, scope, params);
			case "search_transcripts":
				return this.searchTranscripts(id, scope, params);
			case "schedule":
				return this.schedule(id, scope, params);
			case "loop":
				return this.loop(id, scope, params);
			case "list_schedules":
				return this.listSchedules(id, scope, params);
			case "cancel_schedule":
				return this.cancelSchedule(id, scope, params);
			case "request_human":
				return await this.requestHuman(id, scope, params);
			case "search_thread":
				return this.searchThread(id, scope, params);
			case "react":
				return this.react(id, scope, params);
			case "resume_chapter":
				return this.resumeChapter(id, scope);
			case "new_chapter":
				return await this.newChapter(id, scope);
			default:
				return failure(id, "unknown_method", "Unknown bridge method");
		}
	}

	// -- chapters -----------------------------------------------------------

	/**
	 * A teammate's own memory. The persona in scope is whose tape is searched,
	 * for a peer connection too: a teammate answering a colleague still
	 * remembers its own conversation with the user.
	 */
	private searchThread(id: number, scope: BridgeScope, params: Record<string, unknown>): BridgeResponse {
		const limit = integer(params.limit, 12, 1, 40);
		if (limit === undefined) return failure(id, "bad_params", "Invalid limit");
		if (params.query === undefined) {
			const chapters = this.dependencies.chapters.list(scope.personaId).slice(0, limit);
			return success(id, {
				chapters: chapters.map((chapter) => ({
					id: chapter.id,
					title: chapter.title ?? "Untitled",
					startedAt: chapter.startedAt,
					...(chapter.endedAt !== undefined ? { endedAt: chapter.endedAt } : { open: true }),
					...(chapter.status ? { status: chapter.status } : {}),
					...(chapter.note ? { note: chapter.note } : {}),
					messages: chapter.messages,
				})),
			});
		}
		const query = text(params.query, 200);
		if (!query || query.length < 2) return failure(id, "bad_params", "Invalid search");
		const { hits, truncated } = this.dependencies.chapters.search(scope.personaId, query, limit);
		return success(id, { hits, truncated });
	}

	/** One emoji on the user's latest message — acknowledgement without a turn. */
	private react(id: number, scope: BridgeScope, params: Record<string, unknown>): BridgeResponse {
		const emoji = text(params.emoji, 16);
		if (!emoji) return failure(id, "bad_params", "Send one emoji.");
		const result = this.dependencies.react(scope.personaId, emoji);
		if ("error" in result) return failure(id, "bad_params", result.error);
		return success(id, { reacted: emoji, on: result.on });
	}

	/** Only the human conversation has chapters to rotate; a peer thread does not. */
	private resumeChapter(id: number, scope: BridgeScope): BridgeResponse {
		if (scope.kind !== "human") {
			return failure(id, "bad_params", "Chapters belong to the conversation with the user, not a peer thread");
		}
		const result = this.dependencies.chapters.resume(scope.personaId);
		if (!result.ok) return failure(id, result.reason === "busy" ? "busy" : "not_found", result.detail);
		return success(id, {
			resumed: true,
			title: result.title,
			note: "Your current turn ends here; the reopened context answers the user next.",
		});
	}

	private async newChapter(id: number, scope: BridgeScope): Promise<BridgeResponse> {
		if (scope.kind !== "human") {
			return failure(id, "bad_params", "Chapters belong to the conversation with the user, not a peer thread");
		}
		const { title } = await this.dependencies.chapters.startFresh(scope.personaId, "agent");
		return success(id, {
			closed: true,
			...(title ? { title } : {}),
			note: "The next message from the user starts a fresh context. Finish this reply normally.",
		});
	}

	/**
	 * Blocks the tool call until the human answers the card (or it expires).
	 * The long wait deliberately holds one of the connection's inflight slots
	 * — a teammate waiting on a person is genuinely mid-request.
	 */
	private async requestHuman(
		id: number,
		scope: BridgeScope,
		params: Record<string, unknown>,
	): Promise<BridgeResponse> {
		const reason = text(params.reason, 500);
		const timeout = integer(params.timeout, 600, 10, 3600);
		if (!reason || reason.length < 3 || timeout === undefined) {
			return failure(id, "bad_params", "A reason (3-500 chars) is required");
		}
		const { status } = await requestHumanAction(scope.personaId, reason, timeout);
		return success(id, { status });
	}

	private getContext(id: number, scope: BridgeScope): BridgeResponse {
		const persona = getPersona(scope.personaId);
		if (!persona) return failure(id, "not_found", "Teammate not found");
		return success(id, {
			personaId: persona.id,
			name: persona.name,
			goal: persona.goal,
			cwd: persona.cwd,
			backendId: persona.backendId,
		});
	}

	private async listTeammates(id: number, scope: BridgeScope): Promise<BridgeResponse> {
		const local = listPersonas().map((persona) => ({
			personaId: persona.id,
			name: persona.name,
			goal: persona.goal,
			backendId: persona.backendId,
			...(persona.team ? { team: persona.team } : {}),
			status: this.dependencies.supervisor.info(persona.id).state,
			isYou: persona.id === scope.personaId,
		}));
		/* Teammates on linked desktops appear in the same list — same team,
		 * different room. Their personaId is node-qualified and works as a
		 * message_teammate target; `desktop` says where they live, and an
		 * offline desktop's members are shown stopped rather than hidden,
		 * because a teammate you cannot reach right now still exists. */
		const remote = (await fleetRosters()).flatMap((roster) =>
			roster.teammates.map((teammate) => ({
				personaId: remoteTargetId(roster.node.id, teammate.personaId),
				name: teammate.name,
				goal: teammate.goal ?? "",
				backendId: teammate.backendId,
				...(teammate.team ? { team: teammate.team } : {}),
				status: roster.online ? teammate.state : ("stopped" as const),
				desktop: roster.node.name,
				isYou: false,
			})),
		);
		return success(id, { teammates: [...local, ...remote] });
	}

	/**
	 * A team name as a target. Teams never speak — the message goes to the
	 * least-recently-picked available member, who is told it was a pickup
	 * and routes it onward if a different member owns the work.
	 *
	 * The decisions, made here rather than in a bug report:
	 * - Rotation is least-recently-picked with the history persisted, so a
	 *   restart does not reset to member one, a member removed mid-rotation
	 *   simply stops mattering, and a new member — never picked — is next.
	 * - The caller is never its own pickup; a team of one (yourself) is no
	 *   team at all and resolves like any unknown target.
	 * - A fully busy team still receives: the message lands on the next in
	 *   rotation and queues there, because "the whole team is heads-down"
	 *   should delay work, not lose it.
	 */
	private async resolveTeamTarget(
		targetId: string,
		callerId: string,
	): Promise<{ memberId: string; team: string } | null> {
		const label = targetId.trim().toLowerCase();
		if (!label) return null;
		type Member = { id: string; team: string; state: string };
		const members: Member[] = listPersonas()
			.filter(
				(persona) =>
					(persona.team ?? "").trim().toLowerCase() === label && persona.id !== callerId,
			)
			.map((persona) => ({
				id: persona.id,
				team: persona.team!,
				state: this.dependencies.supervisor.info(persona.id).state,
			}));
		/* Members on linked desktops join the same rotation. An offline
		 * desktop's members are never picked; a busy fleet still receives on
		 * the next in rotation, exactly as a busy local team does. */
		for (const roster of await fleetRosters()) {
			if (!roster.online) continue;
			for (const teammate of roster.teammates) {
				if ((teammate.team ?? "").trim().toLowerCase() !== label) continue;
				members.push({
					id: remoteTargetId(roster.node.id, teammate.personaId),
					team: teammate.team!,
					state: teammate.state,
				});
			}
		}
		if (members.length === 0) return null;
		const free = members.filter(
			(member) => member.state === "ready" || member.state === "idle",
		);
		const pool = free.length > 0 ? free : members;
		const history = picksFor(label);
		const picked = [...pool].sort(
			(a, b) =>
				(history[a.id] ?? 0) - (history[b.id] ?? 0) ||
				members.indexOf(a) - members.indexOf(b),
		)[0]!;
		notePick(label, picked.id);
		return { memberId: picked.id, team: picked.team };
	}

	private async messageTeammate(
		id: number,
		scope: BridgeScope,
		params: Record<string, unknown>,
	): Promise<BridgeResponse> {
		const targetId = text(params.target, 200);
		let message = text(params.message, TEAMMATE_MESSAGE_MAX_LENGTH);
		if (!targetId || message === undefined || message.length === 0) {
			return failure(id, "bad_params", "A target and non-empty message are required");
		}
		/* A name that is nobody's id may be a team's — and a team, or the
		 * picked member, may live on another desktop. Remote targets carry a
		 * node-qualified id; the delivery crosses the fleet wire and the
		 * reply returns through the same single-round-trip contract. */
		let deliverTo = targetId;
		if (!listPersonas().some((persona) => persona.id === targetId)) {
			const routed = await this.resolveTeamTarget(targetId, scope.personaId);
			if (routed) {
				deliverTo = routed.memberId;
				const banner = `[To the ${routed.team} team — you are the pickup. If another ${routed.team} member owns this, forward it with message_teammate.]\n\n`;
				message = banner + message.slice(0, TEAMMATE_MESSAGE_MAX_LENGTH - banner.length);
			}
		}
		const remote = parseRemoteTarget(deliverTo);
		if (remote && !listPersonas().some((persona) => persona.id === deliverTo)) {
			const caller = getPersona(scope.personaId);
			const result = await deliverToPeer(remote.nodeId, {
				targetPersonaId: remote.personaId,
				fromPersona: { id: scope.personaId, name: caller?.name ?? "A teammate" },
				message,
			});
			if (!result.ok) {
				return failure(
					id,
					"backend_unavailable",
					result.detail ?? "The remote desktop did not answer",
				);
			}
			return success(id, { from: result.from ?? deliverTo, reply: result.reply ?? "" });
		}
		let chain: Chain;
		if (scope.kind === "human") {
			chain = { id: randomUUID(), depth: 0, path: [] };
		} else {
			const inherited = this.dependencies.peers.activeDelivery(peerSessionKey(scope));
			if (!inherited) return failure(id, "internal", "No active peer delivery");
			chain = { ...inherited, depth: inherited.depth + 1 };
		}
		const result = await this.dependencies.peers.deliver({
			callerId: scope.personaId,
			targetId: deliverTo,
			message,
			chain,
		});
		if (!result.ok) return failure(id, result.reason, result.detail);
		return success(id, {
			from: result.from,
			reply: result.reply,
			...(result.note ? { note: result.note } : {}),
		});
	}

	/** Resolve a team to the member who owns its most recent standing thread. */
	private resolveTeamThreadTarget(targetId: string, callerId: string): Persona | undefined {
		const label = targetId.trim().toLowerCase();
		if (!label) return undefined;
		const history = picksFor(label);
		return listPersonas()
			.filter(
				(persona) =>
					persona.id !== callerId && (persona.team ?? "").trim().toLowerCase() === label,
			)
			.map((persona, rosterIndex) => {
				const key = threadKey(callerId, persona.id);
				const meta = threads.readMeta(key);
				return { persona, rosterIndex, meta, pickedAt: history[persona.id] ?? 0 };
			})
			.filter(({ meta }) => Boolean(meta))
			.sort(
				(a, b) =>
					b.pickedAt - a.pickedAt ||
					(b.meta?.updatedAt ?? 0) - (a.meta?.updatedAt ?? 0) ||
					a.rosterIndex - b.rosterIndex,
			)[0]?.persona;
	}

	/**
	 * A peer thread is addressed by its two participants, never by a caller-
	 * supplied path or thread key. Metadata is checked again before reading so
	 * even a malformed/misplaced file cannot turn this into arbitrary access.
	 */
	private readAgentThread(
		id: number,
		scope: BridgeScope,
		params: Record<string, unknown>,
	): BridgeResponse {
		const requested = text(params.target, 200);
		const limit = integer(params.limit, 30, 1, 100);
		if (!requested || limit === undefined) {
			return failure(id, "bad_params", "Invalid agent thread request");
		}
		const caller = getPersona(scope.personaId);
		if (!caller) return failure(id, "not_found", "Calling teammate not found");
		let target = getPersona(requested);
		if (!target) target = this.resolveTeamThreadTarget(requested, caller.id);
		if (!target) return failure(id, "not_found", "Teammate thread not found");
		if (target.id === caller.id) return failure(id, "self_target", "Cannot read a thread with yourself");

		const key = threadKey(caller.id, target.id);
		const meta = threads.readMeta(key);
		const expected = [caller.id, target.id].sort();
		if (
			!meta ||
			meta.a !== expected[0] ||
			meta.b !== expected[1] ||
			!meta.sides ||
			typeof meta.sides.user !== "string" ||
			typeof meta.sides.agent !== "string" ||
			new Set([meta.sides.user, meta.sides.agent]).size !== 2 ||
			![meta.sides.user, meta.sides.agent].every((participant) => expected.includes(participant))
		) {
			return failure(id, "not_found", "Teammate thread not found");
		}

		const all = threads
			.load(key)
			.filter((event) => event.kind === "user" || event.kind === "agent");
		const selected = all.slice(-limit).map((event) => {
			const speaker = event.kind === "user" ? meta.sides.user : meta.sides.agent;
			return { from: speaker === caller.id ? "me" : "them", text: event.text, at: event.ts };
		});
		let truncated = all.length > selected.length;
		while (selected.length > 1 && JSON.stringify(selected).length > 20_000) {
			selected.shift();
			truncated = true;
		}
		if (selected[0] && JSON.stringify(selected).length > 20_000) {
			selected[0].text = selected[0].text.slice(-19_000);
			truncated = true;
		}
		return success(id, {
			threadKey: key,
			personaId: target.id,
			name: target.name,
			messages: selected,
			truncated,
		});
	}

	/**
	 * `scope` identifies who is asking, in step with `getContext`/`listTeammates`/
	 * `messageTeammate`. V1 deliberately doesn't restrict which persona a
	 * teammate can read here — every teammate gets broad, roster-wide
	 * "Toad-aware context" by design, gated only by whatever tool-approval
	 * setting the human picked for that harness. Accepting scope now, even
	 * unused for a decision, keeps this call shaped like its siblings and
	 * ready for that decision without another signature change.
	 */
	private readTranscript(id: number, _scope: BridgeScope, params: Record<string, unknown>): BridgeResponse {
		const target = text(params.target, 200);
		const limit = integer(params.limit, 30, 1, 100);
		if (!target || limit === undefined) return failure(id, "bad_params", "Invalid transcript request");
		const persona = getPersona(target);
		if (!persona) return failure(id, "not_found", "Teammate not found");
		const { messages, truncated: capped } = transcript.recentMessages(target, limit);
		const selected = messages.map((event) => ({
			from: event.kind === "user" ? "user" : "teammate",
			text: event.text,
			at: event.ts,
		}));
		let truncated = capped;
		while (selected.length > 1 && JSON.stringify(selected).length > 20_000) {
			selected.shift();
			truncated = true;
		}
		if (selected[0] && JSON.stringify(selected).length > 20_000) {
			selected[0].text = selected[0].text.slice(-19_000);
			truncated = true;
		}
		return success(id, {
			personaId: persona.id,
			name: persona.name,
			messages: selected,
			truncated,
		});
	}

	/** See `readTranscript` for why `scope` is accepted but not yet enforced. */
	private searchTranscripts(id: number, _scope: BridgeScope, params: Record<string, unknown>): BridgeResponse {
		const query = text(params.query, 200);
		const limit = integer(params.limit, 20, 1, 40);
		if (!query || query.length < 2 || limit === undefined) {
			return failure(id, "bad_params", "Invalid transcript search");
		}
		const requested = params.targets;
		if (
			requested !== undefined &&
			(!Array.isArray(requested) || requested.some((item) => typeof item !== "string"))
		) {
			return failure(id, "bad_params", "Invalid transcript targets");
		}
		const allowed = new Map(listPersonas().map((persona) => [persona.id, persona]));
		const personas: Persona[] = requested
			? (requested as string[]).map((target) => allowed.get(target)).filter(Boolean) as Persona[]
			: [...allowed.values()];
		const needle = query.toLowerCase();
		const hits: Array<Record<string, unknown>> = [];
		let total = 0;
		let truncated = false;
		for (const persona of personas) {
			const { messages, truncated: capped } = transcript.allMessages(persona.id);
			if (capped) truncated = true;
			for (const event of messages) {
				const index = event.text.toLowerCase().indexOf(needle);
				if (index === -1) continue;
				total++;
				if (hits.length >= limit) continue;
				const start = Math.max(0, index - 160);
				const end = Math.min(event.text.length, index + query.length + 160);
				hits.push({
					personaId: persona.id,
					name: persona.name,
					from: event.kind === "user" ? "user" : "teammate",
					at: event.ts,
					excerpt: event.text.slice(start, end),
				});
			}
		}
		return success(id, { hits, truncated: truncated || total > hits.length });
	}

	private schedule(id: number, scope: BridgeScope, params: Record<string, unknown>): BridgeResponse {
		const when = text(params.when, 200);
		const prompt = text(params.prompt, 8_000);
		if (!when || prompt === undefined || prompt.length === 0) {
			return failure(id, "bad_params", "A when and a non-empty prompt are required");
		}
		try {
			return success(id, this.publicJob(this.dependencies.scheduler.schedule(scope.personaId, when, prompt)));
		} catch (error) {
			return this.toolFailure(id, error);
		}
	}

	private loop(id: number, scope: BridgeScope, params: Record<string, unknown>): BridgeResponse {
		const every = text(params.every, 40);
		const prompt = text(params.prompt, 8_000);
		if (!every || prompt === undefined || prompt.length === 0) {
			return failure(id, "bad_params", "An every and a non-empty prompt are required");
		}
		try {
			return success(id, this.publicJob(this.dependencies.scheduler.loop(scope.personaId, every, prompt)));
		} catch (error) {
			return this.toolFailure(id, error);
		}
	}

	private listSchedules(id: number, scope: BridgeScope, params: Record<string, unknown>): BridgeResponse {
		const target = params.target === undefined ? scope.personaId : text(params.target, 200);
		if (!target) return failure(id, "bad_params", "Invalid teammate");
		if (!getPersona(target)) return failure(id, "not_found", "Teammate not found");
		return success(id, {
			jobs: this.dependencies.scheduler.list(target).map((job) => this.publicJob(job)),
		});
	}

	private cancelSchedule(id: number, scope: BridgeScope, params: Record<string, unknown>): BridgeResponse {
		const jobId = text(params.id, 200);
		if (!jobId) return failure(id, "bad_params", "An id is required");
		const cancelled = this.dependencies.scheduler.cancel(jobId, scope.personaId);
		if (!cancelled) return failure(id, "not_found", "Schedule not found");
		return success(id, { cancelled: true });
	}

	private publicJob(job: ScheduledJob): Record<string, unknown> {
		return {
			id: job.id,
			kind: job.kind,
			prompt: job.prompt,
			nextAt: job.nextAt,
			...(job.everyMs !== undefined ? { everyMs: job.everyMs } : {}),
		};
	}

	private toolFailure(id: number, error: unknown): BridgeResponse {
		const code =
			error && typeof error === "object" && "code" in error
				? (String(error.code) as BridgeErrorCode)
				: "internal";
		const detail = error instanceof Error ? error.message : "The request failed";
		return failure(id, code, detail);
	}
}
