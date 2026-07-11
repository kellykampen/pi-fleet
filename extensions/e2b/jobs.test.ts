import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { listJobs, readJob, updateJob, writeJob } from "./jobs.ts";
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
	process.env.FLEET_JOBS_DIR = dir;
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
