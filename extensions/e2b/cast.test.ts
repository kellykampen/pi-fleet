import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { castJob, refreshFromSandbox } from "./cast.ts";
import { readJob, writeJob } from "./jobs.ts";
import type { FleetJob } from "./types.ts";

const ORIGINAL_ENV = { ...process.env };

function clearSensitiveEnv() {
	delete process.env.FLEET_GITHUB_TOKEN;
	delete process.env.GH_TOKEN;
	delete process.env.E2B_API_KEY;
}

function restoreEnv() {
	for (const key of Object.keys(process.env)) {
		if (!(key in ORIGINAL_ENV)) delete process.env[key];
	}
	Object.assign(process.env, ORIGINAL_ENV);
}

test.beforeEach(() => {
	clearSensitiveEnv();
});

test.afterEach(() => {
	restoreEnv();
});

test("non-dry-run cast propagates a successful createSandbox's sandboxId into the persisted job as status running", async () => {
	const jobsDir = await mkdtemp(join(tmpdir(), "pi-fleet-jobs-"));
	process.env.FLEET_JOBS_DIR = jobsDir;
	process.env.E2B_API_KEY = "e2b_test_key";
	process.env.FLEET_GITHUB_TOKEN = "ghp_abcdefghijklmnopqrstuvwxyz1234567890";

	try {
		const job = await castJob(
			{
				profile: "implementer",
				brief: "implement FLT-3",
				codeAccess: "clone",
				repo: "owner/repo",
			},
			{
				createSandbox: async () => ({
					sandboxId: "sandbox-abc123",
					logTail: "sandbox started; runner backgrounded",
				}),
			},
		);

		assert.equal(job.dryRun, false);
		assert.equal(job.status, "running");
		assert.equal(job.sandboxId, "sandbox-abc123");

		const persisted = await readJob(job.jobId);
		assert.equal(persisted.status, "running");
		assert.equal(persisted.sandboxId, "sandbox-abc123");
	} finally {
		await rm(jobsDir, { recursive: true, force: true });
	}
});

test("refreshFromSandbox kills the sandbox and marks the job timeout when result.json never appears", async () => {
	const jobsDir = await mkdtemp(join(tmpdir(), "pi-fleet-jobs-"));
	process.env.FLEET_JOBS_DIR = jobsDir;
	process.env.E2B_API_KEY = "e2b_test_key";

	// createdAt is 200 minutes ago — well past the 90 minute hard timeout.
	const created = new Date(Date.now() - 200 * 60 * 1000).toISOString();
	const job: FleetJob = await writeJob({
		jobId: "job-timeout",
		profile: "implementer",
		status: "running",
		brief: "long-running brief",
		codeAccess: "clone",
		repo: "owner/repo",
		timeoutMinutes: 90,
		dryRun: false,
		sandboxId: "sandbox-timeout",
		createdAt: created,
		updatedAt: created,
	});

	let killed = false;
	try {
		const refreshed = await refreshFromSandbox(job, {
			connectSandbox: async () => ({
				files: {
					// result.json never appears — always throws.
					async read() {
						throw new Error("no result yet");
					},
				},
				async kill() {
					killed = true;
				},
			}),
		});

		assert.equal(killed, true);
		assert.equal(refreshed.status, "timeout");
		assert.match(refreshed.error ?? "", /timeout of 90 minutes/);

		const persisted = await readJob("job-timeout");
		assert.equal(persisted.status, "timeout");
		assert.match(persisted.error ?? "", /timeout of 90 minutes/);
	} finally {
		await rm(jobsDir, { recursive: true, force: true });
	}
});

test("refreshFromSandbox kills the sandbox when a terminal result.json appears", async () => {
	const jobsDir = await mkdtemp(join(tmpdir(), "pi-fleet-jobs-"));
	process.env.FLEET_JOBS_DIR = jobsDir;
	process.env.E2B_API_KEY = "e2b_test_key";

	const created = new Date().toISOString();
	const job: FleetJob = await writeJob({
		jobId: "job-terminal-kill",
		profile: "implementer",
		status: "running",
		brief: "brief",
		codeAccess: "clone",
		repo: "owner/repo",
		timeoutMinutes: 60,
		dryRun: false,
		sandboxId: "sandbox-terminal",
		createdAt: created,
		updatedAt: created,
	});

	let killed = false;
	try {
		const refreshed = await refreshFromSandbox(job, {
			connectSandbox: async () => ({
				files: {
					async read(path: string) {
						if (path === "/work/result.json") {
							return JSON.stringify({ status: "succeeded", commitSha: "abc123" });
						}
						return "";
					},
				},
				async kill() {
					killed = true;
				},
			}),
		});

		assert.equal(killed, true);
		assert.equal(refreshed.status, "succeeded");
		assert.equal(refreshed.commitSha, "abc123");

		const persisted = await readJob("job-terminal-kill");
		assert.equal(persisted.status, "succeeded");
	} finally {
		await rm(jobsDir, { recursive: true, force: true });
	}
});
