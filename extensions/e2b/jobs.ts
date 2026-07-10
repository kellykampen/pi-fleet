import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { sanitizeSecrets } from "./secrets.js";
import type { FleetJob, JobStatus } from "./types.js";
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
	await ensureJobsDir();
	const next = sanitizeForPersistence({
		...job,
		updatedAt: new Date().toISOString(),
	}) as FleetJob;
	await writeFile(
		jobPath(job.jobId),
		`${JSON.stringify(next, null, 2)}\n`,
		"utf8",
	);
	return next;
}

export async function readJob(jobId: string): Promise<FleetJob> {
	try {
		const raw = await readFile(jobPath(jobId), "utf8");
		return JSON.parse(raw) as FleetJob;
	} catch {
		throw new Error(`Unknown jobId: ${jobId} (looked in ${jobsDir()})`);
	}
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

export async function listJobs(): Promise<FleetJob[]> {
	await ensureJobsDir();
	const files = await readdir(jobsDir());
	const jobs: FleetJob[] = [];
	for (const file of files) {
		if (!file.endsWith(".json")) continue;
		try {
			const raw = await readFile(join(jobsDir(), file), "utf8");
			jobs.push(JSON.parse(raw) as FleetJob);
		} catch {
			// skip corrupt
		}
	}
	return jobs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
