import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	buildResultFinalizer,
	buildRunnerScript,
	collectWorkerEnv,
	FLEET_WORKER_MODEL_KEYS,
	normalizeRepoSlug,
	sanitizeSecrets,
} from "./secrets.ts";
import {
	castJob,
	describeSandboxError,
	isOpaqueVersionError,
	MISSING_TEMPLATE_ERROR,
	refreshFromSandbox,
	SANDBOX_VERSION_ERROR_HINT,
} from "./cast.ts";
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
	process.env.FLEET_GITHUB_TOKEN =
		"github_pat_thisSecretMustNotAppearInTheRunnerScript123456";
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

test("normalizeRepoSlug reduces every supported input shape to owner/repo", () => {
	const inputs = [
		"owner/repo",
		"owner/repo.git",
		"github.com/owner/repo",
		"github.com/owner/repo.git",
		"https://github.com/owner/repo",
		"https://github.com/owner/repo.git",
		"git@github.com:owner/repo.git",
		"git@github.com:owner/repo",
		"github.com/owner/repo/",
	];
	for (const input of inputs) {
		assert.equal(normalizeRepoSlug(input), "owner/repo", `input: ${input}`);
	}
});

test("normalizeRepoSlug throws a clear error on invalid input", () => {
	assert.throws(() => normalizeRepoSlug(""), /repo/i);
	assert.throws(() => normalizeRepoSlug("not-a-valid-repo"), /repo/i);
	assert.throws(() => normalizeRepoSlug("github.com/owner"), /repo/i);
	assert.throws(
		() => normalizeRepoSlug("https://github.com/owner/repo/extra"),
		/repo/i,
	);
});

test("buildRunnerScript normalizes a github.com/.../.git repo before every gh invocation", () => {
	const baseJob = {
		jobId: "job-normalize",
		profile: "implementer" as const,
		status: "queued" as const,
		brief: "do the thing",
		timeoutMinutes: 90,
		dryRun: false,
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
	};

	const cloneScript = buildRunnerScript({
		...baseJob,
		codeAccess: "clone",
		repo: "github.com/kellykampen/pi-fleet.git",
	});
	assert.match(cloneScript, /gh repo clone 'kellykampen\/pi-fleet'/);
	assert.equal(cloneScript.includes("github.com/kellykampen/pi-fleet.git"), false);

	const prScript = buildRunnerScript({
		...baseJob,
		codeAccess: "pr",
		repo: "github.com/kellykampen/pi-fleet.git",
		prNumber: 42,
	});
	assert.match(prScript, /gh repo clone 'kellykampen\/pi-fleet'/);
	assert.equal(prScript.includes("github.com/kellykampen/pi-fleet.git"), false);

	const branchScript = buildRunnerScript({
		...baseJob,
		codeAccess: "branch",
		repo: "github.com/kellykampen/pi-fleet.git",
		branch: "feature/x",
	});
	assert.match(branchScript, /gh repo clone 'kellykampen\/pi-fleet'/);
	assert.equal(branchScript.includes("github.com/kellykampen/pi-fleet.git"), false);
});

/**
 * Run the finalizer bash snippet in isolation against a throwaway $WORK dir,
 * exercising the real marker-file → result.json translation that the remote
 * runner performs after pi-implementer exits.
 */
function runFinalizer(work: string, env: Record<string, string>): void {
	const finalizer = buildResultFinalizer();
	execFileSync("bash", ["-c", `set -euo pipefail\n${finalizer}`], {
		env: { ...process.env, WORK: work, ...env },
		stdio: "pipe",
	});
}

test("buildResultFinalizer writes needs_input result.json when the needs-input marker is present", async () => {
	const work = await mkdtemp(join(tmpdir(), "pi-fleet-work-"));
	try {
		await writeFile(
			join(work, "needs-input.json"),
			JSON.stringify({
				questions: [
					"Which auth provider should the login flow use?",
					"What Node version does the target runtime pin?",
				],
			}),
		);

		// EXIT=0 but the marker is present: needs_input must win over the exit
		// code so ambiguous work never masquerades as a clean success.
		runFinalizer(work, {
			JOB_ID: "job-needs-input",
			EXIT: "0",
			SHA: "abc1234",
			BRANCH: "fleet/needs-input",
		});

		const result = JSON.parse(await readFile(join(work, "result.json"), "utf8"));
		assert.equal(result.status, "needs_input");
		assert.deepEqual(result.questions, [
			"Which auth provider should the login flow use?",
			"What Node version does the target runtime pin?",
		]);
		assert.equal(result.jobId, "job-needs-input");
		assert.equal(result.profile, "implementer");
		// Partial work that landed before the block is still reported.
		assert.equal(result.commitSha, "abc1234");
		assert.equal(result.branch, "fleet/needs-input");
		assert.equal(result.error, null);
	} finally {
		await rm(work, { recursive: true, force: true });
	}
});

test("buildResultFinalizer leaves an existing result.json untouched when a needs-input marker is also present", async () => {
	const work = await mkdtemp(join(tmpdir(), "pi-fleet-work-"));
	try {
		// pi-implementer's own result.json (e.g. it succeeded, then a stray or
		// stale needs-input.json is also on disk). This is the top-precedence
		// tier: an implementer-authored result.json must never be clobbered.
		const ownResult = {
			jobId: "job-precedence",
			profile: "implementer",
			status: "succeeded",
			commitSha: "deadbeef",
			prUrl: "https://github.com/owner/repo/pull/1",
			branch: "fleet/precedence",
			questions: null,
			error: null,
			finishedAt: "2026-01-01T00:00:00.000000Z",
		};
		await writeFile(
			join(work, "result.json"),
			JSON.stringify(ownResult, null, 2) + "\n",
		);
		await writeFile(
			join(work, "needs-input.json"),
			JSON.stringify({ questions: ["Should this ever surface?"] }),
		);

		const finalizer = buildResultFinalizer();
		const output = execFileSync(
			"bash",
			["-c", `set -euo pipefail\n${finalizer}\necho "FINAL_STATUS=$STATUS"`],
			{
				env: {
					...process.env,
					WORK: work,
					JOB_ID: "job-precedence",
					EXIT: "0",
				},
				stdio: "pipe",
			},
		).toString();

		const result = JSON.parse(await readFile(join(work, "result.json"), "utf8"));
		assert.deepEqual(result, ownResult);

		// The log line must reflect the persisted (succeeded) result, not the
		// needs_input the marker file alone would imply.
		assert.match(output, /FINAL_STATUS=succeeded/);
	} finally {
		await rm(work, { recursive: true, force: true });
	}
});

test("buildResultFinalizer falls through to succeeded/failed by exit code when no marker exists", async () => {
	const work = await mkdtemp(join(tmpdir(), "pi-fleet-work-"));
	try {
		runFinalizer(work, { JOB_ID: "job-ok", EXIT: "0" });
		const ok = JSON.parse(await readFile(join(work, "result.json"), "utf8"));
		assert.equal(ok.status, "succeeded");
		assert.equal(ok.questions, null);
		assert.equal(ok.error, null);

		await rm(join(work, "result.json"));

		runFinalizer(work, { JOB_ID: "job-bad", EXIT: "2" });
		const bad = JSON.parse(await readFile(join(work, "result.json"), "utf8"));
		assert.equal(bad.status, "failed");
		assert.equal(bad.questions, null);
		assert.match(bad.error ?? "", /exited 2/);
	} finally {
		await rm(work, { recursive: true, force: true });
	}
});

test("refreshFromSandbox persists needs_input status and questions from a remote result.json", async () => {
	const jobsDir = await mkdtemp(join(tmpdir(), "pi-fleet-jobs-"));
	process.env.FLEET_JOBS_DIR = jobsDir;
	process.env.E2B_API_KEY = "e2b_test_key";

	const now = new Date().toISOString();
	const job: FleetJob = await writeJob({
		jobId: "job-needs-input-refresh",
		profile: "implementer",
		status: "running",
		brief: "ambiguous brief",
		codeAccess: "clone",
		repo: "owner/repo",
		timeoutMinutes: 90,
		dryRun: false,
		sandboxId: "sandbox-needs-input",
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
								status: "needs_input",
								questions: [
									"Should this target the v1 or v2 API?",
									"Is a DB migration in scope?",
								],
							});
						}
						throw new Error("not ready");
					},
				},
			}),
		});

		assert.equal(refreshed.status, "needs_input");
		assert.deepEqual(refreshed.questions, [
			"Should this target the v1 or v2 API?",
			"Is a DB migration in scope?",
		]);

		const persisted = await readJob("job-needs-input-refresh");
		assert.equal(persisted.status, "needs_input");
		assert.deepEqual(persisted.questions, [
			"Should this target the v1 or v2 API?",
			"Is a DB migration in scope?",
		]);
	} finally {
		await rm(jobsDir, { recursive: true, force: true });
	}
});

test("sanitizeSecrets redacts exact env values and common GitHub token shapes", () => {
	process.env.FLEET_GITHUB_TOKEN =
		"github_pat_exactTokenValue_abcdefghijklmnopqrstuvwxyz123456";
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

test("non-dry-run cast fails clearly before sandboxId when FLEET_E2B_TEMPLATE is missing", async () => {
	const jobsDir = await mkdtemp(join(tmpdir(), "pi-fleet-jobs-"));
	process.env.FLEET_JOBS_DIR = jobsDir;
	process.env.E2B_API_KEY = "e2b_test_key";
	process.env.FLEET_GITHUB_TOKEN = "ghp_abcdefghijklmnopqrstuvwxyz1234567890";
	delete process.env.FLEET_E2B_TEMPLATE;

	try {
		// No `createSandbox` override: this exercises the real tryCreateSandbox,
		// whose missing-template check must throw before it ever imports the e2b
		// SDK or makes a network call — regression test for the "Cannot read
		// properties of undefined (reading 'version')" crash seen when
		// FLEET_E2B_TEMPLATE was unset.
		const job = await castJob({
			profile: "implementer",
			brief: "implement FLT-3",
			codeAccess: "clone",
			repo: "owner/repo",
		});

		assert.equal(job.dryRun, false);
		assert.equal(job.status, "failed");
		assert.equal(job.sandboxId, undefined);
		assert.equal(job.error, MISSING_TEMPLATE_ERROR);

		const persisted = await readJob(job.jobId);
		assert.equal(persisted.status, "failed");
		assert.equal(persisted.error, MISSING_TEMPLATE_ERROR);
	} finally {
		await rm(jobsDir, { recursive: true, force: true });
	}
});

test("isOpaqueVersionError detects the SDK envd version crash across phrasings", () => {
	assert.equal(
		isOpaqueVersionError(
			new Error("Cannot read properties of undefined (reading 'version')"),
		),
		true,
	);
	// JSC/WebKit phrasing
	assert.equal(
		isOpaqueVersionError(
			new Error("undefined is not an object (evaluating 'e.version')"),
		),
		true,
	);
	assert.equal(isOpaqueVersionError("null has no property version"), false);
	// Unrelated SDK errors must pass through untouched.
	assert.equal(
		isOpaqueVersionError(new Error("Unauthorized, please check your credentials")),
		false,
	);
	assert.equal(
		isOpaqueVersionError(
			new Error("You need to update the template to use the new SDK."),
		),
		false,
	);
});

test("describeSandboxError rewraps the opaque version crash but preserves other errors", () => {
	const wrapped = describeSandboxError(
		new Error("Cannot read properties of undefined (reading 'version')"),
	);
	assert.ok(wrapped.startsWith(SANDBOX_VERSION_ERROR_HINT));
	assert.match(wrapped, /original SDK error/);
	assert.match(wrapped, /FLEET_E2B_TEMPLATE/);

	const passthrough = describeSandboxError(new Error("Unauthorized"));
	assert.equal(passthrough, "Unauthorized");
});

test("non-dry-run cast surfaces the actionable hint when the SDK throws the opaque version error", async () => {
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
				createSandbox: async () => {
					throw new Error(
						"Cannot read properties of undefined (reading 'version')",
					);
				},
			},
		);

		assert.equal(job.status, "failed");
		assert.equal(job.sandboxId, undefined);
		assert.ok((job.error ?? "").startsWith(SANDBOX_VERSION_ERROR_HINT));

		const persisted = await readJob(job.jobId);
		assert.equal(persisted.status, "failed");
		assert.match(persisted.error ?? "", /republish it with the matching CLI/);
	} finally {
		await rm(jobsDir, { recursive: true, force: true });
	}
});

test("refreshFromSandbox sanitizes remote result fields and log tails before persisting", async () => {
	const jobsDir = await mkdtemp(join(tmpdir(), "pi-fleet-jobs-"));
	process.env.FLEET_JOBS_DIR = jobsDir;
	process.env.E2B_API_KEY = "e2b_test_key";
	process.env.FLEET_GITHUB_TOKEN =
		"github_pat_remoteSecretValue_abcdefghijklmnopqrstuvwxyz123456";
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
		assert.equal(
			refreshed.error?.includes(process.env.FLEET_GITHUB_TOKEN),
			false,
		);
		assert.equal(
			refreshed.logTail?.includes(process.env.FLEET_GITHUB_TOKEN),
			false,
		);
		assert.equal(
			refreshed.blockers?.join(" ").includes(process.env.OPENAI_API_KEY),
			false,
		);
		assert.match(refreshed.error ?? "", /\*\*\*/);

		const persistedRaw = await readFile(
			join(jobsDir, "job-sanitize.json"),
			"utf8",
		);
		assert.equal(persistedRaw.includes(process.env.FLEET_GITHUB_TOKEN), false);
		assert.equal(persistedRaw.includes(process.env.OPENAI_API_KEY), false);
	} finally {
		await rm(jobsDir, { recursive: true, force: true });
	}
});
