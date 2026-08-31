import { randomUUID } from "node:crypto";
import { SCHEDULE_NAME_MAX, scheduledRunOf } from "../shared/scheduled";
import { needsStart } from "../shared/session";
import type { ScheduledJob, ScheduledRun } from "../shared/types";
import { getPersona } from "./store/personas";
import {
	dropPersonaJobs,
	getJob,
	listJobs,
	putJob,
	removeJob,
} from "./store/schedules";

const MIN_LOOP = 15_000;
const MAX_LOOP = 7 * 86_400_000;
const MAX_AHEAD = 30 * 86_400_000;
const MAX_JOBS = 20;

const UNITS: Record<string, number> = {
	s: 1_000,
	sec: 1_000,
	secs: 1_000,
	second: 1_000,
	seconds: 1_000,
	m: 60_000,
	min: 60_000,
	mins: 60_000,
	minute: 60_000,
	minutes: 60_000,
	h: 3_600_000,
	hr: 3_600_000,
	hrs: 3_600_000,
	hour: 3_600_000,
	hours: 3_600_000,
	d: 86_400_000,
	day: 86_400_000,
	days: 86_400_000,
};

export function parseDuration(value: string): number | undefined {
	const match = value
		.trim()
		.toLowerCase()
		.match(/^(\d+(?:\.\d+)?)\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)$/);
	if (!match) return undefined;
	const amount = Number(match[1]);
	const unit = UNITS[match[2]!];
	if (!Number.isFinite(amount) || amount <= 0 || !unit) return undefined;
	return Math.round(amount * unit);
}

export function parseWhen(value: string, now = Date.now()): number | undefined {
	const relative = parseDuration(value);
	if (relative !== undefined) return now + relative;
	const ms = Number(value);
	if (Number.isFinite(ms) && ms > 1_000_000_000_000) return ms;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * How a firing reaches its teammate.
 *
 * `prompt` is the job's own text, unframed: the framing the agent reads is
 * built from `run` at the supervisor, so the tape can keep the prompt and the
 * agent can keep its "scheduled ·" prefix without the two being the same
 * string.
 */
type Wake = (personaId: string, prompt: string, run: ScheduledRun) => Promise<void>;

/** What a job may be given beyond its prompt and its clock. */
export type JobOptions = { name?: string; quiet?: boolean };

/**
 * A job's optional half, stored only when it says something.
 *
 * The name is clipped rather than rejected: an over-long one is just the
 * prompt again, which is exactly what the name exists to keep out of the tape,
 * and refusing the whole job over it would be a worse trade. `quiet: false` is
 * dropped so that "not quiet" has one representation on disk.
 */
function trimOptions(options: JobOptions): JobOptions {
	const name = options.name?.replace(/\s+/g, " ").trim().slice(0, SCHEDULE_NAME_MAX);
	return {
		...(name ? { name } : {}),
		...(options.quiet ? { quiet: true } : {}),
	};
}

/**
 * Durable wakes for teammates.
 *
 * The tools write the job; this keeps the clock. A missed tick while Toad was
 * closed fires once on reopen rather than catching up a pile of them — the
 * teammate should do the work now, not replay every interval it slept through.
 */
export class Scheduler {
	private timers = new Map<string, ReturnType<typeof setTimeout>>();

	constructor(
		private options: {
			wake: Wake;
			changed(jobs: ScheduledJob[]): void;
		},
	) {}

	start(): void {
		for (const job of listJobs()) this.arm(job);
	}

	stop(): void {
		for (const timer of this.timers.values()) clearTimeout(timer);
		this.timers.clear();
	}

	list(personaId?: string): ScheduledJob[] {
		return listJobs(personaId);
	}

	schedule(personaId: string, when: string, prompt: string, options: JobOptions = {}): ScheduledJob {
		const nextAt = parseWhen(when);
		if (nextAt === undefined) {
			throw Object.assign(new Error("when must be a duration like 20m or an ISO time"), {
				code: "bad_params",
			});
		}
		const wait = nextAt - Date.now();
		if (wait < 1_000 || wait > MAX_AHEAD) {
			throw Object.assign(new Error("schedule must be between 1 second and 30 days from now"), {
				code: "bad_params",
			});
		}
		return this.create({ ...trimOptions(options), personaId, kind: "schedule", prompt, nextAt });
	}

	loop(personaId: string, every: string, prompt: string, options: JobOptions = {}): ScheduledJob {
		const everyMs = parseDuration(every);
		if (everyMs === undefined || everyMs < MIN_LOOP || everyMs > MAX_LOOP) {
			throw Object.assign(new Error("every must be a duration between 15s and 7d"), {
				code: "bad_params",
			});
		}
		return this.create({
			...trimOptions(options),
			personaId,
			kind: "loop",
			prompt,
			everyMs,
			nextAt: Date.now() + everyMs,
		});
	}

	/**
	 * The user's own hand on the silence.
	 *
	 * An agent sets `quiet` when it creates a job, from what the user asked for
	 * in words — which is the one place a model's judgement is involved at all.
	 * This is the correction: the schedule list shows the flag and can flip it,
	 * so a job that got it wrong is one tap from right, and a job that has gone
	 * quiet on something the user now wants to hear about can be reopened.
	 */
	setQuiet(id: string, quiet: boolean, personaId?: string): boolean {
		const job = getJob(id);
		if (!job) return false;
		if (personaId && job.personaId !== personaId) return false;
		if ((job.quiet ?? false) === quiet) return true;
		const next: ScheduledJob = { ...job };
		if (quiet) next.quiet = true;
		else delete next.quiet;
		putJob(next);
		this.options.changed(listJobs());
		return true;
	}

	cancel(id: string, personaId?: string): boolean {
		const job = getJob(id);
		if (!job) return false;
		if (personaId && job.personaId !== personaId) return false;
		this.disarm(id);
		const removed = removeJob(id);
		if (removed) this.options.changed(listJobs());
		return removed;
	}

	dropPersona(personaId: string): void {
		for (const job of listJobs(personaId)) this.disarm(job.id);
		dropPersonaJobs(personaId);
		this.options.changed(listJobs());
	}

	private create(
		input: Omit<ScheduledJob, "id" | "createdAt"> & { prompt: string },
	): ScheduledJob {
		if (!getPersona(input.personaId)) {
			throw Object.assign(new Error("Teammate not found"), { code: "not_found" });
		}
		const prompt = input.prompt.trim();
		if (prompt.length === 0 || prompt.length > 8_000) {
			throw Object.assign(new Error("prompt must be 1–8000 characters"), { code: "bad_params" });
		}
		if (listJobs(input.personaId).length >= MAX_JOBS) {
			throw Object.assign(new Error(`A teammate can have at most ${MAX_JOBS} scheduled jobs`), {
				code: "busy",
			});
		}
		const job = putJob({
			...input,
			prompt,
			id: randomUUID(),
			createdAt: Date.now(),
		});
		this.arm(job);
		this.options.changed(listJobs());
		return job;
	}

	private arm(job: ScheduledJob): void {
		this.disarm(job.id);
		const delay = Math.max(0, job.nextAt - Date.now());
		this.timers.set(
			job.id,
			setTimeout(() => {
				void this.fire(job.id);
			}, Math.min(delay, 2_000_000_000)),
		);
	}

	private disarm(id: string): void {
		const timer = this.timers.get(id);
		if (timer) clearTimeout(timer);
		this.timers.delete(id);
	}

	private async fire(id: string): Promise<void> {
		const job = getJob(id);
		if (!job) {
			this.disarm(id);
			return;
		}
		if (!getPersona(job.personaId)) {
			this.cancel(id);
			return;
		}

		try {
			await this.options.wake(job.personaId, job.prompt, scheduledRunOf(job));
		} catch {
			this.arm({ ...job, nextAt: Date.now() + 60_000 });
			return;
		}

		if (job.kind === "loop" && job.everyMs) {
			const next = putJob({
				...job,
				lastFiredAt: Date.now(),
				nextAt: Date.now() + job.everyMs,
			});
			this.arm(next);
			this.options.changed(listJobs());
			return;
		}

		this.disarm(id);
		removeJob(id);
		this.options.changed(listJobs());
	}
}

export async function wakeTeammate(
	supervisor: {
		info(personaId: string): { state: import("../shared/types").SessionState };
		start(personaId: string): Promise<unknown>;
		prompt(personaId: string, text: string): Promise<void>;
		promptScheduled(personaId: string, prompt: string, run: ScheduledRun): Promise<void>;
	},
	personaId: string,
	text: string,
	/* Absent for the other caller of this seam: a self-hop's continuation,
	 * which is Toad speaking for the teammate rather than a job firing. */
	run?: ScheduledRun,
): Promise<void> {
	const state = supervisor.info(personaId).state;
	if (needsStart(state) || state === "error") {
		await supervisor.start(personaId);
	}
	if (run) await supervisor.promptScheduled(personaId, text, run);
	else await supervisor.prompt(personaId, text);
}
