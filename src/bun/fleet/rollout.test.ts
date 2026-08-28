import { describe, expect, test } from "bun:test";
import type { FleetRolloutProgress, UpdateStatus } from "../../shared/types";
import { createFleetRollout, type RolloutDesk } from "./rollout";

/**
 * The orchestration is the risky part — order, patience, and when to stop —
 * so it is exercised against desks made of paper. Time is injected, so a
 * ten-minute wait costs nothing here.
 */

type FakeOptions = {
	version: string;
	latest?: string;
	/** Names reported as mid-turn, consumed one poll at a time. */
	busyFor?: number;
	busyNames?: string[];
	/** Version the desk comes back on after applying. Defaults to latest. */
	returnsAs?: string;
	/** Never answers: an asleep desk. */
	unreachable?: boolean;
	/** Answers, but never comes back after the restart. */
	neverReturns?: boolean;
};

function fakeDesk(nodeId: string, name: string, options: FakeOptions) {
	const log: string[] = [];
	let version = options.version;
	let applied = false;
	let busyPolls = options.busyFor ?? 0;

	const status = (): UpdateStatus => ({
		phase: "idle",
		message: "",
		currentVersion: version,
		currentHash: `${version}-hash`,
		latestVersion: options.latest,
		blockedBy: busyPolls > 0 ? (options.busyNames ?? ["Boris"]) : undefined,
	});

	const desk: RolloutDesk = {
		nodeId,
		name,
		async check() {
			if (options.unreachable) throw new Error("not reachable");
			log.push("check");
			return status();
		},
		async download() {
			log.push("download");
			return status();
		},
		async apply() {
			log.push("apply");
			applied = true;
			if (!options.neverReturns) version = options.returnsAs ?? options.latest ?? version;
			throw new Error("gone before it could answer");
		},
		async status() {
			if (options.unreachable) throw new Error("not reachable");
			if (busyPolls > 0) {
				busyPolls--;
				return status();
			}
			return status();
		},
	};
	return {
		desk,
		log,
		get applied() {
			return applied;
		},
		get version() {
			return version;
		},
	};
}

function harness(remotes: RolloutDesk[], local: RolloutDesk) {
	const published: FleetRolloutProgress[] = [];
	let clock = 0;
	const rollout = createFleetRollout({
		remotes: () => remotes,
		local: () => local,
		publish: (progress) => published.push(progress),
		/* Waiting advances the injected clock instead of the wall, so the
		 * deadline logic is exercised in milliseconds of real time. */
		wait: async (ms) => {
			clock += ms;
		},
		now: () => clock,
	});
	return { rollout, published };
}

describe("fleet rollout", () => {
	test("updates every remote desk before this one, and only once each", async () => {
		const a = fakeDesk("a", "Mac mini", { version: "0.2.8", latest: "0.2.9" });
		const b = fakeDesk("b", "W11", { version: "0.2.8", latest: "0.2.9" });
		const here = fakeDesk("me", "beastie", { version: "0.2.8", latest: "0.2.9" });
		const { rollout } = harness([a.desk, b.desk], here.desk);

		const result = await rollout.run();

		expect(a.applied).toBe(true);
		expect(b.applied).toBe(true);
		expect(here.applied).toBe(true);
		expect(a.log.filter((entry) => entry === "apply")).toHaveLength(1);
		expect(result.desks.map((desk) => desk.name)).toEqual(["Mac mini", "W11", "beastie"]);
		expect(result.desks.every((desk) => desk.step === "done" || desk.step === "restarting")).toBe(true);
	});

	test("the driver restarts last, after every remote is on the new build", async () => {
		const order: string[] = [];
		const watch = (name: string, desk: RolloutDesk): RolloutDesk => ({
			...desk,
			async apply() {
				order.push(name);
				return desk.apply();
			},
		});
		const a = fakeDesk("a", "Mac mini", { version: "0.2.8", latest: "0.2.9" });
		const here = fakeDesk("me", "beastie", { version: "0.2.8", latest: "0.2.9" });
		const { rollout } = harness([watch("Mac mini", a.desk)], watch("beastie", here.desk));

		await rollout.run();

		expect(order).toEqual(["Mac mini", "beastie"]);
	});

	test("a desk already on the target is left alone", async () => {
		const ahead = fakeDesk("a", "Mac mini", { version: "0.2.9", latest: "0.2.9" });
		const here = fakeDesk("me", "beastie", { version: "0.2.8", latest: "0.2.9" });
		const { rollout } = harness([ahead.desk], here.desk);

		const result = await rollout.run();

		expect(ahead.applied).toBe(false);
		expect(result.desks[0]).toMatchObject({ step: "done", detail: "already up to date" });
	});

	test("an unreachable desk is skipped, and the rollout carries on", async () => {
		const asleep = fakeDesk("a", "W11", { version: "0.2.8", latest: "0.2.9", unreachable: true });
		const awake = fakeDesk("b", "Mac mini", { version: "0.2.8", latest: "0.2.9" });
		const here = fakeDesk("me", "beastie", { version: "0.2.8", latest: "0.2.9" });
		const { rollout } = harness([asleep.desk, awake.desk], here.desk);

		const result = await rollout.run();

		expect(result.desks[0]).toMatchObject({ name: "W11", step: "skipped", detail: "not reachable" });
		expect(awake.applied).toBe(true);
		expect(here.applied).toBe(true);
	});

	test("a desk that tries and does not come back halts the rollout", async () => {
		const broken = fakeDesk("a", "W11", { version: "0.2.8", latest: "0.2.9", neverReturns: true });
		const untouched = fakeDesk("b", "Mac mini", { version: "0.2.8", latest: "0.2.9" });
		const here = fakeDesk("me", "beastie", { version: "0.2.8", latest: "0.2.9" });
		const { rollout } = harness([broken.desk, untouched.desk], here.desk);

		const result = await rollout.run();

		expect(result.desks[0]).toMatchObject({ name: "W11", step: "failed" });
		expect(result.message).toContain("W11");
		// The rest of the room is left exactly as it was.
		expect(untouched.applied).toBe(false);
		expect(here.applied).toBe(false);
		expect(result.running).toBe(false);
	});

	test("a working teammate is waited out, not overruled", async () => {
		const busy = fakeDesk("a", "Mac mini", {
			version: "0.2.8",
			latest: "0.2.9",
			busyFor: 3,
			busyNames: ["Big Frank"],
		});
		const here = fakeDesk("me", "beastie", { version: "0.2.8", latest: "0.2.9" });
		const { rollout, published } = harness([busy.desk], here.desk);

		await rollout.run();

		expect(busy.applied).toBe(true);
		expect(published.some((entry) => entry.message.includes("Big Frank"))).toBe(true);
	});

	test("a desk busy past the deadline stops the rollout rather than interrupting it", async () => {
		const stuck = fakeDesk("a", "Mac mini", {
			version: "0.2.8",
			latest: "0.2.9",
			busyFor: 10_000,
			busyNames: ["Nancy"],
		});
		const here = fakeDesk("me", "beastie", { version: "0.2.8", latest: "0.2.9" });
		const { rollout } = harness([stuck.desk], here.desk);

		const result = await rollout.run();

		expect(stuck.applied).toBe(false);
		expect(result.desks[0]).toMatchObject({ step: "failed", detail: "still working" });
		expect(here.applied).toBe(false);
	});

	test("nothing happens when the room is already current", async () => {
		const a = fakeDesk("a", "Mac mini", { version: "0.2.9", latest: "0.2.9" });
		const here = fakeDesk("me", "beastie", { version: "0.2.9", latest: "0.2.9" });
		const { rollout } = harness([a.desk], here.desk);

		const result = await rollout.run();

		expect(result.message).toContain("already up to date");
		expect(a.applied).toBe(false);
		expect(here.applied).toBe(false);
	});

	test("a straggler is picked up even when the driver is already current", async () => {
		// The 0.2.11 incident: the Mac was skipped, the driver updated itself,
		// and the next click reported "already up to date" over a stale room.
		const straggler = fakeDesk("a", "Mac mini", {
			version: "0.2.10",
			latest: "0.2.11",
			returnsAs: "0.2.11",
		});
		const here = fakeDesk("me", "beastie", { version: "0.2.11", latest: "0.2.11" });
		const { rollout } = harness([straggler.desk], here.desk);

		const result = await rollout.run();

		expect(straggler.applied).toBe(true);
		expect(here.applied).toBe(false);
		expect(result.desks.find((desk) => desk.name === "Mac mini")).toMatchObject({ step: "done" });
		expect(result.desks.find((desk) => desk.name === "beastie")).toMatchObject({
			step: "done",
			detail: "already up to date",
		});
		expect(result.message).not.toContain("already up to date.");
	});

	test("a second run is refused while one is in flight", async () => {
		const slow = fakeDesk("a", "Mac mini", { version: "0.2.8", latest: "0.2.9" });
		const here = fakeDesk("me", "beastie", { version: "0.2.8", latest: "0.2.9" });
		const { rollout } = harness([slow.desk], here.desk);

		const first = rollout.run();
		const second = await rollout.run();
		expect(second.message).toContain("already running");
		await first;
	});
});
