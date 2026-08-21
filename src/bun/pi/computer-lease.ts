import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

/**
 * One computer, several hands.
 *
 * A teammate and its subagents share one desktop: one pointer, one keyboard,
 * one visible screen. Interleaving two multi-step UI flows garbles both, so
 * computer access is a lease held for a whole piece of work, not a per-click
 * lock. The container serializes individual actions; this decides whose
 * *task* the desktop belongs to.
 *
 * The two sides wait differently on purpose. A subagent is silent and has
 * nowhere else to be, so its computer call parks in a FIFO queue until the
 * desktop frees up. The parent is mid-conversation with a person, so it never
 * blocks: a call while a subagent holds the lease returns a "hands busy"
 * result naming the holder, and the parent decides — wait for the report,
 * or do something else.
 *
 * Holds end at natural boundaries: a subagent's when its run ends, the
 * parent's when its turn settles. Everything here is in-process state — the
 * proxy cannot tell callers apart (one bearer token), but these wrappers are
 * handed out per session, so they always know whose hand is moving.
 */

export type ComputerHolder =
	| { kind: "parent" }
	| { kind: "child"; runId: string; label: string };

type Waiter = {
	runId: string;
	label: string;
	grant(): void;
	cancel(err: Error): void;
};

type Lease = {
	holder?: { who: ComputerHolder; since: number };
	queue: Waiter[];
};

const leases = new Map<string, Lease>();

function leaseFor(personaId: string): Lease {
	let lease = leases.get(personaId);
	if (!lease) {
		lease = { queue: [] };
		leases.set(personaId, lease);
	}
	return lease;
}

function sameHolder(a: ComputerHolder, b: ComputerHolder): boolean {
	if (a.kind === "parent" || b.kind === "parent") return a.kind === b.kind;
	return a.runId === b.runId;
}

/** Waits its turn: resolves once this run holds the desktop. */
function holdForChild(
	personaId: string,
	runId: string,
	label: string,
	signal?: AbortSignal,
): Promise<void> {
	const lease = leaseFor(personaId);
	if (lease.holder && sameHolder(lease.holder.who, { kind: "child", runId, label })) {
		return Promise.resolve();
	}
	if (!lease.holder) {
		lease.holder = { who: { kind: "child", runId, label }, since: Date.now() };
		return Promise.resolve();
	}
	if (signal?.aborted) return Promise.reject(new Error("cancelled while waiting for the computer"));

	return new Promise<void>((resolve, reject) => {
		const waiter: Waiter = {
			runId,
			label,
			grant: () => {
				signal?.removeEventListener("abort", onAbort);
				resolve();
			},
			cancel: (err) => {
				signal?.removeEventListener("abort", onAbort);
				reject(err);
			},
		};
		const onAbort = () => {
			const at = lease.queue.indexOf(waiter);
			if (at >= 0) lease.queue.splice(at, 1);
			waiter.cancel(new Error("cancelled while waiting for the computer"));
		};
		signal?.addEventListener("abort", onAbort, { once: true });
		lease.queue.push(waiter);
	});
}

/**
 * The parent's non-blocking side: take the desktop if it is free (or already
 * ours), otherwise report whose hands are on it.
 */
function tryHoldForParent(
	personaId: string,
): { ok: true } | { ok: false; label: string; heldForMs: number } {
	const lease = leaseFor(personaId);
	if (!lease.holder) {
		lease.holder = { who: { kind: "parent" }, since: Date.now() };
		return { ok: true };
	}
	if (lease.holder.who.kind === "parent") return { ok: true };
	return {
		ok: false,
		label: lease.holder.who.label,
		heldForMs: Date.now() - lease.holder.since,
	};
}

/** Ends a hold. A release by someone who is not the holder is a no-op. */
export function releaseComputer(personaId: string, who: ComputerHolder): void {
	const lease = leases.get(personaId);
	if (!lease) return;
	if (who.kind === "child") {
		// A run that never got the lease may still be queued.
		const at = lease.queue.findIndex((waiter) => waiter.runId === who.runId);
		if (at >= 0) lease.queue.splice(at, 1)[0]!.cancel(new Error("the run ended"));
	}
	if (!lease.holder || !sameHolder(lease.holder.who, who)) return;
	const next = lease.queue.shift();
	if (next) {
		lease.holder = {
			who: { kind: "child", runId: next.runId, label: next.label },
			since: Date.now(),
		};
		next.grant();
	} else {
		lease.holder = undefined;
		leases.delete(personaId);
	}
}

/** True for the computer MCP server's tools as `McpTools` names them. */
export function isComputerTool(name: string): boolean {
	return name === "computer" || name.startsWith("computer__");
}

type Execute = ToolDefinition["execute"];

function withExecute(tool: ToolDefinition, execute: Execute): ToolDefinition {
	return { ...tool, execute } as ToolDefinition;
}

/**
 * The parent's computer tools, gated. Non-computer tools pass through
 * untouched. The busy text is written for the parent's next move, not as an
 * error: waiting is usually the right one.
 */
export function gateParentComputer(personaId: string, tools: ToolDefinition[]): ToolDefinition[] {
	return tools.map((tool) => {
		if (!isComputerTool(tool.name)) return tool;
		return withExecute(tool, async (...args: Parameters<Execute>) => {
			const grant = tryHoldForParent(personaId);
			if (!grant.ok) {
				const minutes = Math.max(1, Math.round(grant.heldForMs / 60_000));
				return {
					content: [
						{
							type: "text" as const,
							text: `Your hands are busy: a subagent (${grant.label}) has been using the computer for ${minutes} minute${minutes === 1 ? "" : "s"}. Wait for its report, or do work that does not need the screen.`,
						},
					],
					details: {},
				};
			}
			return (tool.execute as Execute)(...args);
		});
	});
}

/**
 * A subagent's computer tools: the first call waits its turn for the desktop,
 * and every call is reported to `onCall` for the run's action log.
 */
export function gateChildComputer(
	personaId: string,
	runId: string,
	label: string,
	tools: ToolDefinition[],
	onCall: (tool: string, params: unknown) => void,
): ToolDefinition[] {
	return tools.map((tool) => {
		if (!isComputerTool(tool.name)) return tool;
		return withExecute(tool, async (...args: Parameters<Execute>) => {
			const signal = args[2] as AbortSignal | undefined;
			await holdForChild(personaId, runId, label, signal);
			onCall(tool.name, args[1]);
			return (tool.execute as Execute)(...args);
		});
	});
}
