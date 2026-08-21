import { randomUUID } from "node:crypto";
import { needsStart } from "../shared/session";
import type { ScheduledJob } from "../shared/types";
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

type Wake = (personaId: string, text: string) => Promise<void>;

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

	schedule(personaId: string, when: string, prompt: string): ScheduledJob {
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
		return this.create({ personaId, kind: "schedule", prompt, nextAt });
	}

	loop(personaId: string, every: string, prompt: string): ScheduledJob {
		const everyMs = parseDuration(every);
		if (everyMs === undefined || everyMs < MIN_LOOP || everyMs > MAX_LOOP) {
			throw Object.assign(new Error("every must be a duration between 15s and 7d"), {
				code: "bad_params",
			});
		}
		return this.create({
			personaId,
			kind: "loop",
			prompt,
			everyMs,
			nextAt: Date.now() + everyMs,
		});
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

		const prefix = job.kind === "loop" ? "loop" : "scheduled";
		const text = `${prefix} · ${job.prompt}`;
		try {
			await this.options.wake(job.personaId, text);
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
	},
	personaId: string,
	text: string,
): Promise<void> {
	const state = supervisor.info(personaId).state;
	if (needsStart(state) || state === "error") {
		await supervisor.start(personaId);
	}
	await supervisor.prompt(personaId, text);
}
