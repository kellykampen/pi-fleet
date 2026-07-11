import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { castJob } from "./cast.ts";
import { readJob } from "./jobs.ts";

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
