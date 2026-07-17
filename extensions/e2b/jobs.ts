import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, openSync } from "node:fs";
import {
	chmod,
	mkdir,
	lstat,
	readFile,
	readdir,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { ConvexJobStore, isConvexConfigured } from "./convexStore.js";
import { assertRuntimePathNoSymlinks, runtimePath } from "./runtimePaths.js";
import { sanitizeSecrets } from "./secrets.js";
import type { FleetJob, JobFilter, JobStatus, JobStore } from "./types.js";
import { isTerminal } from "./types.js";

const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const LOCK_WAIT_MS = 5_000;

export class CorruptJobError extends Error {
	constructor(jobId: string, cause?: unknown) {
		super(`Corrupt job record: ${jobId}`, { cause });
		this.name = "CorruptJobError";
	}
}

export function validateJobId(jobId: string): string {
	if (!JOB_ID.test(jobId) || jobId === "." || jobId === "..")
		throw new Error(`Invalid job ID: ${JSON.stringify(jobId)}`);
	return jobId;
}

export function jobsDir(): string {
	return runtimePath("state", "e2b", "jobs");
}

function jobPath(jobId: string): string {
	return join(jobsDir(), `${validateJobId(jobId)}.json`);
}

export async function ensureJobsDir(): Promise<void> {
	const dir = jobsDir();
	await assertRuntimePathNoSymlinks(dir);
	await mkdir(dir, { recursive: true, mode: 0o700 });
	await assertRuntimePathNoSymlinks(dir);
	await chmod(dir, 0o700);
}

async function withLock<T>(
	name: string,
	operation: () => Promise<T>,
): Promise<T> {
	await ensureJobsDir();
	const lock = join(jobsDir(), `.lock-${validateJobId(name)}`);
	await assertRuntimePathNoSymlinks(lock);
	const deadline = Date.now() + LOCK_WAIT_MS;
	for (;;) {
		try {
			await mkdir(lock, { mode: 0o700 });
			await assertRuntimePathNoSymlinks(lock);
			break;
		} catch (error) {
			if (
				(error as NodeJS.ErrnoException).code !== "EEXIST" ||
				Date.now() >= deadline
			)
				throw new Error(`Timed out acquiring job lock: ${name}`, {
					cause: error,
				});
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
	}
	try {
		return await operation();
	} finally {
		await rm(lock, { recursive: true, force: true });
	}
}

async function atomicWrite(path: string, contents: string): Promise<void> {
	const tmp = `${path}.tmp.${process.pid}.${randomUUID()}`;
	await writeFile(tmp, contents, { encoding: "utf8", mode: 0o600, flag: "wx" });
	await chmod(tmp, 0o600);
	const fd = openSync(tmp, "r");
	try {
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	await rename(tmp, path);
	const dirFd = openSync(jobsDir(), "r");
	try {
		fsyncSync(dirFd);
	} finally {
		closeSync(dirFd);
	}
}

async function readRecord(jobId: string): Promise<FleetJob | null> {
	const path = jobPath(jobId);
	try {
		const stat = await lstat(path);
		if (stat.isSymbolicLink())
			throw new Error(`Job record is a symlink: ${jobId}`);
		if (!stat.isFile())
			throw new Error(`Job record is not a regular file: ${jobId}`);
		const parsed = JSON.parse(await readFile(path, "utf8")) as FleetJob;
		if (!parsed || parsed.jobId !== jobId)
			throw new Error("record ID mismatch");
		return parsed;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		if (error instanceof Error && /symlink|regular file/.test(error.message))
			throw error;
		const quarantine = join(jobsDir(), "quarantine");
		await assertRuntimePathNoSymlinks(quarantine);
		await mkdir(quarantine, { recursive: true, mode: 0o700 });
		await assertRuntimePathNoSymlinks(quarantine);
		await chmod(quarantine, 0o700);
		const destination = join(quarantine, `${jobId}.${Date.now()}.corrupt`);
		await assertRuntimePathNoSymlinks(destination);
		await rename(path, destination).catch(() => undefined);
		throw new CorruptJobError(jobId, error);
	}
}

async function putUnlocked(job: FleetJob): Promise<void> {
	validateJobId(job.jobId);
	await ensureJobsDir();
	const path = jobPath(job.jobId);
	try {
		const stat = await lstat(path);
		if (stat.isSymbolicLink() || !stat.isFile())
			throw new Error(`Unsafe existing job record: ${job.jobId}`);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	await atomicWrite(path, `${JSON.stringify(job, null, 2)}\n`);
}

export function newJobId(): string {
	return randomUUID();
}

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

/** Private filesystem fallback beneath <PI_FLEET_HOME>/state/e2b/jobs. */
export const localStore: JobStore = {
	async put(job) {
		await withLock(job.jobId, () => putUnlocked(job));
	},
	async get(jobId) {
		validateJobId(jobId);
		await ensureJobsDir();
		return readRecord(jobId);
	},
	async list(filter) {
		await ensureJobsDir();
		const jobs: FleetJob[] = [];
		for (const file of await readdir(jobsDir())) {
			if (!file.endsWith(".json")) continue;
			const id = file.slice(0, -5);
			validateJobId(id);
			const job = await readRecord(id);
			if (job && matchesFilter(job, filter)) jobs.push(job);
		}
		return jobs.sort(byCreatedAtDesc);
	},
};

export function getJobStore(): JobStore {
	return isConvexConfigured() ? new ConvexJobStore() : localStore;
}

function sanitizeForPersistence(value: unknown): unknown {
	if (typeof value === "string") return sanitizeSecrets(value);
	if (Array.isArray(value)) return value.map(sanitizeForPersistence);
	if (value && typeof value === "object")
		return Object.fromEntries(
			Object.entries(value).map(([key, item]) => [
				key,
				sanitizeForPersistence(item),
			]),
		);
	return value;
}

function nextJob(job: FleetJob): FleetJob {
	return sanitizeForPersistence({
		...job,
		updatedAt: new Date().toISOString(),
	}) as FleetJob;
}

export async function writeJob(job: FleetJob): Promise<FleetJob> {
	const next = nextJob(job);
	await getJobStore().put(next);
	return next;
}

export async function findJob(jobId: string): Promise<FleetJob | null> {
	return getJobStore().get(validateJobId(jobId));
}

export async function findJobByIdOrSandboxId(
	value: string,
): Promise<FleetJob | null> {
	validateJobId(value);
	const store = getJobStore();
	const direct = await store.get(value);
	if (direct) return direct;
	return (await store.list()).find((job) => job.sandboxId === value) ?? null;
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
	validateJobId(jobId);
	if (!isConvexConfigured())
		return withLock(jobId, async () => {
			const current = await readRecord(jobId);
			if (!current) throw new Error(`Unknown jobId: ${jobId}`);
			const finishedAt =
				patch.status && isTerminal(patch.status) && !current.finishedAt
					? new Date().toISOString()
					: (patch.finishedAt ?? current.finishedAt);
			const next = nextJob({
				...current,
				...patch,
				jobId: current.jobId,
				finishedAt,
			});
			await putUnlocked(next);
			return next;
		});
	const current = await readJob(jobId);
	const finishedAt =
		patch.status && isTerminal(patch.status) && !current.finishedAt
			? new Date().toISOString()
			: (patch.finishedAt ?? current.finishedAt);
	return writeJob({ ...current, ...patch, jobId: current.jobId, finishedAt });
}

export async function listJobs(filter?: JobFilter): Promise<FleetJob[]> {
	return getJobStore().list(filter);
}

export interface RetentionOptions {
	now?: Date;
	archiveAfterDays?: number;
	deleteAfterDays?: number;
	apply?: boolean;
	deleteArchived?: boolean;
}
export async function retainJobs(
	options: RetentionOptions = {},
): Promise<{ archive: string[]; delete: string[] }> {
	const now = options.now ?? new Date();
	const archiveBefore =
		now.getTime() - (options.archiveAfterDays ?? 30) * 86_400_000;
	const deleteBefore =
		now.getTime() - (options.deleteAfterDays ?? 180) * 86_400_000;
	const result = { archive: [] as string[], delete: [] as string[] };
	const dir = jobsDir();
	await assertRuntimePathNoSymlinks(dir);
	let files: string[];
	try {
		const stat = await lstat(dir);
		if (!stat.isDirectory()) throw new Error("Job store path is not a directory");
		files = await readdir(dir);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return result;
		throw error;
	}
	for (const file of files) {
		if (!file.endsWith(".json")) continue;
		const id = validateJobId(file.slice(0, -5));
		const path = jobPath(id);
		await assertRuntimePathNoSymlinks(path);
		const stat = await lstat(path);
		if (!stat.isFile()) throw new Error(`Unsafe job record: ${file}`);
		let job: FleetJob;
		try { job = JSON.parse(await readFile(path, "utf8")) as FleetJob; }
		catch (error) { throw new CorruptJobError(id, error); }
		if (job.jobId !== id) throw new CorruptJobError(id);
		if (isTerminal(job.status) && Date.parse(job.finishedAt ?? job.updatedAt) < archiveBefore)
			result.archive.push(id);
	}
	const archiveDir = join(dir, "archive");
	await assertRuntimePathNoSymlinks(archiveDir);
	let archivedFiles: string[] = [];
	try { archivedFiles = await readdir(archiveDir); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	for (const file of archivedFiles) {
		if (!file.endsWith(".json")) continue;
		const path = join(archiveDir, file);
		const stat = await lstat(path);
		if (stat.isSymbolicLink() || !stat.isFile())
			throw new Error(`Unsafe archived job record: ${file}`);
		let archived: FleetJob;
		try {
			archived = JSON.parse(await readFile(path, "utf8")) as FleetJob;
		} catch (error) {
			throw new CorruptJobError(file.slice(0, -5), error);
		}
		if (Date.parse(archived.finishedAt ?? archived.updatedAt) < deleteBefore)
			result.delete.push(file.slice(0, -5));
	}
	if (options.apply) {
		await assertRuntimePathNoSymlinks(archiveDir);
		await mkdir(archiveDir, { recursive: true, mode: 0o700 });
		await assertRuntimePathNoSymlinks(archiveDir);
		await chmod(archiveDir, 0o700);
		for (const id of result.archive)
			await withLock(id, async () => {
				const destination = join(archiveDir, `${id}.json`);
				await assertRuntimePathNoSymlinks(destination);
				await rename(jobPath(id), destination);
			});
		if (options.deleteArchived)
			for (const id of result.delete) await rm(join(archiveDir, `${id}.json`));
	}
	result.archive.sort();
	result.delete.sort();
	return result;
}
