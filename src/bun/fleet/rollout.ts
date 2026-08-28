import type { FleetRolloutProgress, FleetRolloutStep, UpdateStatus } from "../../shared/types";

/**
 * Updating the room, one desk at a time.
 *
 * A fleet is only coherent when every desk runs the same build — replication,
 * routing and membership all assume peers understand each other — but updating
 * by hand means walking to each machine, and updating all at once means the
 * room goes dark together, mid-turn, without asking.
 *
 * So: a rolling update, driven by the desk where the human clicked. No new
 * authority is minted for it. The driver already holds an authenticated link
 * to every member and can already ask each one to check, download and restart;
 * this is the order and the patience around those calls.
 *
 * Three rules earn their keep:
 *
 *  - **Remote desks first, the driver last.** The orchestrator restarts too,
 *    and a process cannot supervise its own replacement.
 *  - **Nobody is interrupted mid-turn.** A desk with a working teammate is
 *    waited on, not overruled — the same refusal the local restart already
 *    honours, applied over the wire.
 *  - **A desk that tries and fails stops the rollout.** Half a fleet on a new
 *    build is the InvalidUpdateIdentity incident with more steps: silent,
 *    plausible, and wrong. A desk that cannot be reached at all is merely
 *    skipped — it will update itself later, and refusing to proceed because
 *    one machine is asleep would make the feature useless.
 */

/** How long a desk may be busy before the rollout gives up waiting for it. */
const IDLE_WAIT_MS = 10 * 60_000;
const IDLE_POLL_MS = 5_000;
/** A restart is a relaunch: process exit, app start, link re-established. */
const RETURN_WAIT_MS = 3 * 60_000;
const RETURN_POLL_MS = 2_000;

export type RolloutDesk = {
	nodeId: string;
	name: string;
	/** Refreshes the desk's view of what is available, and returns it. */
	check(): Promise<UpdateStatus>;
	/** Fetches the payload. Resolves when the desk is ready to restart. */
	download(): Promise<UpdateStatus>;
	/**
	 * Restarts into the prepared build. A desk that obeys never answers — it
	 * is gone before the reply — so a rejection here means it refused, and a
	 * transport failure means it probably went. Both are handled by asking
	 * again once it is back.
	 */
	apply(): Promise<UpdateStatus>;
	/** Current state without side effects; rejects while the desk is away. */
	status(): Promise<UpdateStatus>;
};

export type RolloutDeps = {
	/** Linked desks, in the order they should be updated. */
	remotes(): RolloutDesk[];
	/** This desk. Always updated last. */
	local(): RolloutDesk;
	publish(progress: FleetRolloutProgress): void;
	/** Injected so tests do not spend real minutes waiting. */
	wait(ms: number): Promise<void>;
	now(): number;
};

type DeskProgress = FleetRolloutProgress["desks"][number];

export function createFleetRollout(deps: RolloutDeps) {
	let running = false;

	return {
		get running() {
			return running;
		},

		/**
		 * Rolls every desk that is behind onto the target build.
		 *
		 * The target is whatever the driver's own check reports as available:
		 * one manifest, one answer, so the room cannot be rolled onto two
		 * different builds by two different clocks.
		 */
		async run(): Promise<FleetRolloutProgress> {
			if (running) {
				return {
					running: true,
					desks: [],
					message: "A fleet update is already running.",
				};
			}
			running = true;

			const desks: DeskProgress[] = [];
			const local = deps.local();
			const publish = (message: string) => {
				const progress: FleetRolloutProgress = {
					running,
					target,
					desks: [...desks],
					message,
				};
				deps.publish(progress);
				return progress;
			};

			let target: string | undefined;
			try {
				const here = await local.check();
				target = here.latestVersion;
				if (!target || target === here.currentVersion) {
					running = false;
					return publish("Every desk is already up to date.");
				}

				const step = (desk: DeskProgress, next: FleetRolloutStep, detail?: string) => {
					desk.step = next;
					desk.detail = detail;
				};

				for (const remote of deps.remotes()) {
					const entry: DeskProgress = { nodeId: remote.nodeId, name: remote.name, step: "waiting" };
					desks.push(entry);
					publish(`Updating ${remote.name}…`);

					let state: UpdateStatus;
					try {
						state = await remote.check();
					} catch {
						/* Asleep, or on the far side of a NAT that stopped
						 * answering. Not a failure of the rollout — a desk that
						 * is not here cannot be broken by us. */
						step(entry, "skipped", "not reachable");
						publish(`${remote.name} is not reachable — skipped.`);
						continue;
					}
					if (state.currentVersion === target) {
						step(entry, "done", "already up to date");
						publish(`${remote.name} is already on ${target}.`);
						continue;
					}

					try {
						step(entry, "downloading");
						publish(`${remote.name} is downloading ${target}…`);
						await remote.download();

						const ready = await waitForIdle(remote, entry, publish, deps);
						if (!ready) {
							step(entry, "failed", "still working");
							running = false;
							return publish(
								`Stopped: ${remote.name} was still working after ${Math.round(IDLE_WAIT_MS / 60_000)} minutes.`,
							);
						}

						step(entry, "restarting");
						publish(`${remote.name} is restarting…`);
						/* A desk that obeys is gone before it can answer, so the
						 * call failing is the expected shape of success. What
						 * matters is what comes back. */
						await remote.apply().catch(() => undefined);

						const failure = await waitForReturn(remote, target, deps);
						if (failure) {
							step(entry, "failed", failure.detail);
							running = false;
							return publish(
								`Stopped: ${remote.name} ${failure.reason}. The rest of the room was left alone.`,
							);
						}
						step(entry, "done");
						publish(`${remote.name} is on ${target}.`);
					} catch (error) {
						step(entry, "failed", error instanceof Error ? error.message : "update failed");
						running = false;
						return publish(`Stopped: ${remote.name} could not update. The rest of the room was left alone.`);
					}
				}

				/* Last, and without ceremony: this desk restarts, so whatever we
				 * publish here is the last thing anyone hears from this process. */
				const entry: DeskProgress = { nodeId: local.nodeId, name: local.name, step: "downloading" };
				desks.push(entry);
				publish(`Updating this desk to ${target}…`);
				await local.download();
				const ready = await waitForIdle(local, entry, publish, deps);
				if (!ready) {
					entry.step = "failed";
					entry.detail = "still working";
					running = false;
					return publish("The room is updated. This desk is still working — restart when it finishes.");
				}
				entry.step = "restarting";
				const result = publish(`Restarting into ${target}…`);
				await local.apply().catch(() => undefined);
				return result;
			} finally {
				running = false;
			}
		},
	};
}

/** Waits out a desk's working teammates, reporting who we are waiting on. */
async function waitForIdle(
	desk: RolloutDesk,
	entry: DeskProgress,
	publish: (message: string) => unknown,
	deps: RolloutDeps,
): Promise<boolean> {
	const deadline = deps.now() + IDLE_WAIT_MS;
	for (;;) {
		let state: UpdateStatus;
		try {
			state = await desk.status();
		} catch {
			return false;
		}
		const busy = state.blockedBy ?? [];
		if (busy.length === 0) return true;
		entry.step = "waiting";
		entry.detail = `waiting for ${busy.join(", ")}`;
		publish(`Waiting for ${busy.join(", ")} on ${desk.name}…`);
		if (deps.now() >= deadline) return false;
		await deps.wait(IDLE_POLL_MS);
	}
}

/** Why a desk did not come back on the target build, for the row and the line. */
type ReturnFailure = { detail: string; reason: string };

/**
 * Waits for a restarted desk to answer again, on the build we asked for.
 * Resolves to null when it does, or to why it did not.
 *
 * `currentVersion` is read from the running bundle, so a desk that answers on
 * the old version really is on the old version. When it also carries the
 * updater's record of the failed transaction we can stop on the spot and say
 * what broke, instead of spending the full deadline learning only that
 * something did.
 */
async function waitForReturn(
	desk: RolloutDesk,
	target: string,
	deps: RolloutDeps,
): Promise<ReturnFailure | null> {
	const deadline = deps.now() + RETURN_WAIT_MS;
	for (;;) {
		if (deps.now() >= deadline) {
			return {
				detail: "did not come back on the new build",
				reason: `did not come back on ${target}`,
			};
		}
		await deps.wait(RETURN_POLL_MS);
		try {
			const state = await desk.status();
			if (state.currentVersion === target) return null;
			const failed = state.failedUpdate;
			if (failed && failed.version === target) {
				const where = failed.phase ? ` at ${failed.phase}` : "";
				return {
					detail: `failed${where}`,
					reason: `could not install ${target}${where}${failed.reason ? `: ${failed.reason}` : ""}`,
				};
			}
		} catch {
			// Still away. The deadline is the only thing that ends this.
		}
	}
}
