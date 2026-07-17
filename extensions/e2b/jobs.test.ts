import assert from "node:assert/strict";
import { chmod, lstat, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { CorruptJobError, jobsDir, listJobs, readJob, retainJobs, updateJob, writeJob } from "./jobs.ts";
import type { FleetJob } from "./types.ts";

const ORIGINAL_ENV = { ...process.env };

function restoreEnv() {
	for (const key of Object.keys(process.env)) {
		if (!(key in ORIGINAL_ENV)) delete process.env[key];
	}
	Object.assign(process.env, ORIGINAL_ENV);
}

test.afterEach(() => {
	restoreEnv();
});

function baseJob(overrides: Partial<FleetJob>): FleetJob {
	const now = new Date().toISOString();
	return {
		jobId: overrides.jobId ?? "job-x",
		profile: "implementer",
		status: "queued",
		brief: "do the thing",
		codeAccess: "clone",
		timeoutMinutes: 90,
		dryRun: true,
		createdAt: now,
		updatedAt: now,
		...overrides,
	};
}

async function withTempStore(fn: () => Promise<void>): Promise<void> {
	const dir = await mkdtemp(join(tmpdir(), "pi-fleet-jobs-"));
	process.env.PI_FLEET_HOME = dir;
	delete process.env.FLEET_CONVEX_URL;
	try {
		await fn();
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

test("local store: listJobs filters by status, repo (project), and ticketId", async () => {
	await withTempStore(async () => {
		await writeJob(
			baseJob({
				jobId: "a",
				status: "running",
				repo: "acme/web",
				ticketId: "FLT-1",
				createdAt: "2026-01-01T00:00:00.000Z",
			}),
		);
		await writeJob(
			baseJob({
				jobId: "b",
				status: "succeeded",
				repo: "acme/web",
				ticketId: "FLT-2",
				createdAt: "2026-01-02T00:00:00.000Z",
			}),
		);
		await writeJob(
			baseJob({
				jobId: "c",
				status: "running",
				repo: "acme/api",
				ticketId: "FLT-1",
				createdAt: "2026-01-03T00:00:00.000Z",
			}),
		);

		const byStatus = await listJobs({ status: "running" });
		assert.deepEqual(
			byStatus.map((j) => j.jobId),
			["c", "a"],
		);

		const byRepo = await listJobs({ repo: "acme/web" });
		assert.deepEqual(
			byRepo.map((j) => j.jobId),
			["b", "a"],
		);

		const byTicket = await listJobs({ ticketId: "FLT-1" });
		assert.deepEqual(
			byTicket.map((j) => j.jobId),
			["c", "a"],
		);

		const combined = await listJobs({
			status: ["running", "succeeded"],
			repo: "acme/web",
		});
		assert.deepEqual(
			combined.map((j) => j.jobId),
			["b", "a"],
		);

		const none = await listJobs({ status: "failed" });
		assert.deepEqual(none, []);

		const all = await listJobs();
		assert.equal(all.length, 3);
	});
});

test("local store: updateJob still stamps finishedAt on terminal status", async () => {
	await withTempStore(async () => {
		await writeJob(baseJob({ jobId: "t", status: "running" }));
		const done = await updateJob("t", { status: "succeeded" });
		assert.equal(done.status, "succeeded");
		assert.ok(done.finishedAt, "finishedAt should be stamped on terminal");
		const persisted = await readJob("t");
		assert.equal(persisted.finishedAt, done.finishedAt);
	});
});

test("local store rejects traversal, separators, absolute IDs, and symlinks", async () => {
	await withTempStore(async () => {
		for (const id of ["../escape", "a/b", "a\\b", "/absolute", ".", "..", ""])
			await assert.rejects(() => readJob(id), /job ID/i);
		await writeJob(baseJob({ jobId: "legacy_job-01.abc" }));
		assert.equal((await readJob("legacy_job-01.abc")).jobId, "legacy_job-01.abc");
		const outside = join(jobsDir(), "..", "outside.json");
		await writeFile(outside, "{}\n");
		await symlink(outside, join(jobsDir(), "linked.json"));
		await assert.rejects(() => readJob("linked"), /symlink/i);
	});
});

test("local writes are private, atomic, and concurrent updates do not lose fields", async () => {
	await withTempStore(async () => {
		await writeJob(baseJob({ jobId: "secure", status: "running" }));
		assert.equal((await lstat(jobsDir())).mode & 0o777, 0o700);
		assert.equal((await lstat(join(jobsDir(), "secure.json"))).mode & 0o777, 0o600);
		await Promise.all([
			updateJob("secure", { branch: "one" }),
			updateJob("secure", { commitSha: "abc" }),
		]);
		const job = await readJob("secure");
		assert.equal(job.branch, "one");
		assert.equal(job.commitSha, "abc");
		assert.equal((await readdir(jobsDir())).some((f) => f.includes(".tmp.")), false);
	});
});

test("corrupt records raise explicitly and are quarantined", async () => {
	await withTempStore(async () => {
		await writeJob(baseJob({ jobId: "broken" }));
		await chmod(join(jobsDir(), "broken.json"), 0o600);
		await writeFile(join(jobsDir(), "broken.json"), "not-json");
		await assert.rejects(() => readJob("broken"), CorruptJobError);
		assert.equal((await readdir(join(jobsDir(), "quarantine"))).some((f) => f.startsWith("broken.")), true);
	});
});

test("retention is dry-run by default, preserves active, archives terminal, then deletes old archives", async () => {
	await withTempStore(async () => {
		const old = "2025-01-01T00:00:00.000Z";
		await writeJob(baseJob({ jobId: "active", status: "running", createdAt: old, updatedAt: old }));
		await writeJob(baseJob({ jobId: "done", status: "succeeded", createdAt: old, updatedAt: old, finishedAt: old }));
		const dry = await retainJobs({ now: new Date("2026-01-01"), archiveAfterDays: 30, deleteAfterDays: 90 });
		assert.deepEqual(dry.archive, ["done"]);
		assert.ok(await readFile(join(jobsDir(), "done.json"), "utf8"));
		await retainJobs({ now: new Date("2026-01-01"), archiveAfterDays: 30, deleteAfterDays: 90, apply: true });
		assert.equal((await readdir(join(jobsDir(), "archive"))).some((f) => f === "done.json"), true);
		const deleted = await retainJobs({ now: new Date("2026-05-01"), archiveAfterDays: 30, deleteAfterDays: 90, apply: true, deleteArchived: true });
		assert.deepEqual(deleted.delete, ["done"]);
		assert.equal((await readdir(join(jobsDir(), "archive"))).includes("done.json"), false);
	});
});
