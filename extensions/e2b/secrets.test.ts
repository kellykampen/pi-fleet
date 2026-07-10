import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	buildRunnerScript,
	collectWorkerEnv,
	FLEET_WORKER_MODEL_KEYS,
	sanitizeSecrets,
} from "./secrets.ts";
import { castJob, refreshFromSandbox } from "./cast.ts";
import { readJob, writeJob } from "./jobs.ts";
import type { FleetJob } from "./types.ts";

const ORIGINAL_ENV = { ...process.env };

function clearSensitiveEnv() {
	delete process.env.FLEET_GITHUB_TOKEN;
	delete process.env.GH_TOKEN;
	delete process.env.E2B_API_KEY;
	for (const key of FLEET_WORKER_MODEL_KEYS) delete process.env[key];
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

test("collectWorkerEnv forwards GitHub and fleet worker keys under canonical names", () => {
	process.env.GH_TOKEN = "ghp_abcdefghijklmnopqrstuvwxyz1234567890";
	process.env.OPENAI_API_KEY = "sk-worker-openai";
	process.env.ANTHROPIC_API_KEY = "sk-worker-anthropic";

	assert.deepEqual(collectWorkerEnv(), {
		FLEET_GITHUB_TOKEN: "ghp_abcdefghijklmnopqrstuvwxyz1234567890",
		OPENAI_API_KEY: "sk-worker-openai",
		ANTHROPIC_API_KEY: "sk-worker-anthropic",
	});
});

test("buildRunnerScript never embeds token values", () => {
	process.env.FLEET_GITHUB_TOKEN = "github_pat_thisSecretMustNotAppearInTheRunnerScript123456";
	process.env.OPENAI_API_KEY = "sk-worker-secret";
	const script = buildRunnerScript({
		jobId: "job-12345678",
		profile: "implementer",
		status: "queued",
		brief: "do the thing",
		codeAccess: "clone",
		repo: "owner/repo",
		timeoutMinutes: 90,
		dryRun: false,
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
	});

	assert.equal(script.includes(process.env.FLEET_GITHUB_TOKEN), false);
	assert.equal(script.includes(process.env.OPENAI_API_KEY), false);
	assert.match(script, /FLEET_GITHUB_TOKEN/);
});

test("sanitizeSecrets redacts exact env values and common GitHub token shapes", () => {
	process.env.FLEET_GITHUB_TOKEN = "github_pat_exactTokenValue_abcdefghijklmnopqrstuvwxyz123456";
	process.env.OPENROUTER_API_KEY = "sk-or-worker-secret";

	const sanitized = sanitizeSecrets(
		`token=${process.env.FLEET_GITHUB_TOKEN} provider=${process.env.OPENROUTER_API_KEY} fallback=ghp_abcdefghijklmnopqrstuvwxyz1234567890`,
	);

	assert.equal(sanitized.includes(process.env.FLEET_GITHUB_TOKEN), false);
	assert.equal(sanitized.includes(process.env.OPENROUTER_API_KEY), false);
	assert.equal(sanitized, "token=*** provider=*** fallback=***");
});

test("non-dry-run cast fails clearly before sandbox creation when GitHub token is missing", async () => {
	const jobsDir = await mkdtemp(join(tmpdir(), "pi-fleet-jobs-"));
	process.env.FLEET_JOBS_DIR = jobsDir;
	process.env.E2B_API_KEY = "e2b_test_key";
	delete process.env.FLEET_GITHUB_TOKEN;
	delete process.env.GH_TOKEN;
	let sandboxCreated = false;

	try {
		const job = await castJob(
			{
				profile: "implementer",
				brief: "implement FLT-2",
				codeAccess: "clone",
				repo: "owner/repo",
			},
			{
				createSandbox: async () => {
					sandboxCreated = true;
					return { sandboxId: "sandbox", logTail: "started" };
				},
			},
		);

		assert.equal(sandboxCreated, false);
		assert.equal(job.dryRun, false);
		assert.equal(job.status, "failed");
		assert.match(job.error ?? "", /FLEET_GITHUB_TOKEN.*GH_TOKEN/);

		const persisted = await readJob(job.jobId);
		assert.equal(persisted.status, "failed");
		assert.match(persisted.error ?? "", /FLEET_GITHUB_TOKEN.*GH_TOKEN/);
	} finally {
		await rm(jobsDir, { recursive: true, force: true });
	}
});

test("refreshFromSandbox sanitizes remote result fields and log tails before persisting", async () => {
	const jobsDir = await mkdtemp(join(tmpdir(), "pi-fleet-jobs-"));
	process.env.FLEET_JOBS_DIR = jobsDir;
	process.env.E2B_API_KEY = "e2b_test_key";
	process.env.FLEET_GITHUB_TOKEN = "github_pat_remoteSecretValue_abcdefghijklmnopqrstuvwxyz123456";
	process.env.OPENAI_API_KEY = "sk-worker-remote-secret";

	const now = new Date().toISOString();
	const job: FleetJob = await writeJob({
		jobId: "job-sanitize",
		profile: "implementer",
		status: "running",
		brief: "brief",
		codeAccess: "clone",
		repo: "owner/repo",
		timeoutMinutes: 90,
		dryRun: false,
		sandboxId: "sandbox-id",
		createdAt: now,
		updatedAt: now,
	});

	try {
		const refreshed = await refreshFromSandbox(job, {
			connectSandbox: async () => ({
				files: {
					async read(path: string) {
						if (path === "/work/result.json") {
							return JSON.stringify({
								status: "failed",
								error: `remote error leaked ${process.env.FLEET_GITHUB_TOKEN}`,
								blockers: [`model leaked ${process.env.OPENAI_API_KEY}`],
							});
						}
						if (path === "/work/job.log") {
							return `log leaked ${process.env.FLEET_GITHUB_TOKEN} and ${process.env.OPENAI_API_KEY}`;
						}
						throw new Error("unexpected path");
					},
				},
			}),
		});

		assert.equal(refreshed.status, "failed");
		assert.equal(refreshed.error?.includes(process.env.FLEET_GITHUB_TOKEN), false);
		assert.equal(refreshed.logTail?.includes(process.env.FLEET_GITHUB_TOKEN), false);
		assert.equal(refreshed.blockers?.join(" ").includes(process.env.OPENAI_API_KEY), false);
		assert.match(refreshed.error ?? "", /\*\*\*/);

		const persistedRaw = await readFile(join(jobsDir, "job-sanitize.json"), "utf8");
		assert.equal(persistedRaw.includes(process.env.FLEET_GITHUB_TOKEN), false);
		assert.equal(persistedRaw.includes(process.env.OPENAI_API_KEY), false);
	} finally {
		await rm(jobsDir, { recursive: true, force: true });
	}
});
