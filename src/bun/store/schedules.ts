import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { ScheduledJob } from "../../shared/types";
import { SCHEDULES_FILE, ensureLayout } from "../paths";

type Stored = { version: 1; jobs: ScheduledJob[] };

function empty(): Stored {
	return { version: 1, jobs: [] };
}

function read(): Stored {
	ensureLayout();
	if (!existsSync(SCHEDULES_FILE)) return empty();
	try {
		const parsed = JSON.parse(readFileSync(SCHEDULES_FILE, "utf8")) as Partial<Stored>;
		if (!Array.isArray(parsed.jobs)) return empty();
		return { version: 1, jobs: parsed.jobs.filter(validJob) };
	} catch {
		return empty();
	}
}

function write(next: Stored): void {
	ensureLayout();
	writeFileSync(SCHEDULES_FILE, `${JSON.stringify(next, null, 2)}\n`, "utf8");
}

function validJob(value: unknown): value is ScheduledJob {
	if (value === null || typeof value !== "object") return false;
	const job = value as Partial<ScheduledJob>;
	if (typeof job.id !== "string" || job.id.length === 0) return false;
	if (typeof job.personaId !== "string" || job.personaId.length === 0) return false;
	if (job.kind !== "schedule" && job.kind !== "loop") return false;
	if (typeof job.prompt !== "string" || job.prompt.trim().length === 0) return false;
	if (typeof job.nextAt !== "number" || !Number.isFinite(job.nextAt)) return false;
	if (typeof job.createdAt !== "number") return false;
	if (job.kind === "loop" && (typeof job.everyMs !== "number" || job.everyMs < 15_000)) {
		return false;
	}
	/* The optional half. A job whose name or quiet flag is the wrong shape is
	 * still a job worth firing, so these only have to be absent or right — the
	 * fallbacks in src/shared/scheduled.ts cover the absent case. */
	if (job.name !== undefined && typeof job.name !== "string") return false;
	if (job.quiet !== undefined && typeof job.quiet !== "boolean") return false;
	return true;
}

export function listJobs(personaId?: string): ScheduledJob[] {
	const jobs = read().jobs;
	const filtered = personaId ? jobs.filter((job) => job.personaId === personaId) : jobs;
	return filtered.slice().sort((a, b) => a.nextAt - b.nextAt);
}

export function getJob(id: string): ScheduledJob | undefined {
	return read().jobs.find((job) => job.id === id);
}

export function putJob(job: ScheduledJob): ScheduledJob {
	const stored = read();
	const index = stored.jobs.findIndex((existing) => existing.id === job.id);
	if (index === -1) stored.jobs.push(job);
	else stored.jobs[index] = job;
	write(stored);
	return job;
}

export function removeJob(id: string): boolean {
	const stored = read();
	const next = stored.jobs.filter((job) => job.id !== id);
	if (next.length === stored.jobs.length) return false;
	write({ version: 1, jobs: next });
	return true;
}

export function dropPersonaJobs(personaId: string): void {
	const stored = read();
	const next = stored.jobs.filter((job) => job.personaId !== personaId);
	if (next.length === stored.jobs.length) return;
	write({ version: 1, jobs: next });
}
