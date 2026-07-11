import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { ConvexJobStore, isConvexConfigured } from "./convexStore.js";
import { sanitizeSecrets } from "./secrets.js";
import type { FleetJob, JobFilter, JobStatus, JobStore } from "./types.js";
import { isTerminal } from "./types.js";

export function jobsDir(): string {
	return (
		process.env.FLEET_JOBS_DIR?.trim() ||
		join(homedir(), ".pi", "fleet", "jobs")
	);
}

function jobPath(jobId: string): string {
	return join(jobsDir(), `${jobId}.json`);
}

export async function ensureJobsDir(): Promise<void> {
	await mkdir(jobsDir(), { recursive: true });
}

export function newJobId(): string {
	return randomUUID();
}

/**
 * Pure filter predicate shared by every store so "list by status/project/ticket"
 * means the same thing whether it runs against local files or a Convex query.
 */
export function matchesFilter(job: FleetJob, filter?: JobFilter): boolean {
	if (!filter) return true;
	if (filter.repo !== undefined && job.repo !== filter.repo) return false;
	if (filter.ticketId !== undefined && job.ticketId !== filter.ticketId)
		return false;
	if (filter.status !== undefined) {
		const wanted = Array.isArray(filter.status)
			? filter.status
			: [filter.status];
		if (!wanted.includes(job.status)) return false;
	}
	return true;
}

function byCreatedAtDesc(a: FleetJob, b: FleetJob): number {
	return b.createdAt.localeCompare(a.createdAt);
}

/** Filesystem-backed store under ~/.pi/fleet/jobs — the always-available fallback. */
export const localStore: JobStore = {
	async put(job: FleetJob): Promise<void> {
		await ensureJobsDir();
		await writeFile(
			jobPath(job.jobId),
			`${JSON.stringify(job, null, 2)}\n`,
			"utf8",
		);
	},
	async get(jobId: string): Promise<FleetJob | null> {
		try {
			const raw = await readFile(jobPath(jobId), "utf8");
			return JSON.parse(raw) as FleetJob;
		} catch {
			return null;
		}
	},
	async list(filter?: JobFilter): Promise<FleetJob[]> {
		await ensureJobsDir();
		const files = await readdir(jobsDir());
		const jobs: FleetJob[] = [];
		for (const file of files) {
			if (!file.endsWith(".json")) continue;
			try {
				const raw = await readFile(join(jobsDir(), file), "utf8");
				const job = JSON.parse(raw) as FleetJob;
				if (matchesFilter(job, filter)) jobs.push(job);
			} catch {
				// skip corrupt
			}
		}
		return jobs.sort(byCreatedAtDesc);
	},
};

/**
 * Select the active store: Convex when configured (FLEET_CONVEX_URL), else the
 * local filesystem store. Evaluated per call so env changes (and tests) take
 * effect without restart.
 */
export function getJobStore(): JobStore {
	if (isConvexConfigured()) return new ConvexJobStore();
	return localStore;
}

function sanitizeForPersistence(value: unknown): unknown {
	if (typeof value === "string") return sanitizeSecrets(value);
	if (Array.isArray(value))
		return value.map((item) => sanitizeForPersistence(item));
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value).map(([key, item]) => [
				key,
				sanitizeForPersistence(item),
			]),
		);
	}
	return value;
}

export async function writeJob(job: FleetJob): Promise<FleetJob> {
	const next = sanitizeForPersistence({
		...job,
		updatedAt: new Date().toISOString(),
	}) as FleetJob;
	await getJobStore().put(next);
	return next;
}

export async function findJob(jobId: string): Promise<FleetJob | null> {
	return getJobStore().get(jobId);
}

export async function findJobByIdOrSandboxId(
	jobIdOrSandboxId: string,
): Promise<FleetJob | null> {
	const store = getJobStore();
	const direct = await store.get(jobIdOrSandboxId);
	if (direct) return direct;
	const jobs = await store.list();
	return jobs.find((job) => job.sandboxId === jobIdOrSandboxId) ?? null;
}

export async function readJob(jobId: string): Promise<FleetJob> {
	const job = await findJob(jobId);
	if (!job) throw new Error(`Unknown jobId: ${jobId}`);
	return job;
}

export async function updateJob(
	jobId: string,
	patch: Partial<FleetJob> & { status?: JobStatus },
): Promise<FleetJob> {
	const current = await readJob(jobId);
	const finishedAt =
		patch.status && isTerminal(patch.status) && !current.finishedAt
			? new Date().toISOString()
			: (patch.finishedAt ?? current.finishedAt);
	return writeJob({
		...current,
		...patch,
		jobId: current.jobId,
		finishedAt,
	});
}

export async function listJobs(filter?: JobFilter): Promise<FleetJob[]> {
	return getJobStore().list(filter);
}
