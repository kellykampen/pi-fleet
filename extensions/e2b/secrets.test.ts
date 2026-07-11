import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	buildRunnerScript,
	collectWorkerEnv,
	FLEET_WORKER_MODEL_KEYS,
	MISSING_FLEET_REPO_URL_ERROR,
	resolveFleetRepoUrl,
	sanitizeSecrets,
} from "./secrets.ts";
import {
	castJob,
	describeSandboxError,
	isOpaqueVersionError,
	MISSING_TEMPLATE_ERROR,
	refreshFromSandbox,
	type RunnableSandbox,
	SANDBOX_VERSION_ERROR_HINT,
	tryCreateSandbox,
} from "./cast.ts";
import { readJob, writeJob } from "./jobs.ts";
import type { FleetJob } from "./types.ts";

const ORIGINAL_ENV = { ...process.env };

function clearSensitiveEnv() {
	delete process.env.FLEET_GITHUB_TOKEN;
	delete process.env.GH_TOKEN;
	delete process.env.E2B_API_KEY;
	delete process.env.FLEET_REPO_URL;
	delete process.env.FLEET_E2B_TEMPLATE;
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

function implementerJob(overrides: Partial<FleetJob> = {}): FleetJob {
	const now = new Date().toISOString();
	return {
		jobId: "job-12345678",
		profile: "implementer",
		status: "queued",
		brief: "do the thing",
		codeAccess: "clone",
		repo: "owner/repo",
		timeoutMinutes: 90,
		dryRun: false,
		createdAt: now,
		updatedAt: now,
		...overrides,
	};
}

test("buildRunnerScript never embeds token values", () => {
	process.env.FLEET_REPO_URL = "https://github.com/owner/pi-fleet.git";
	process.env.FLEET_GITHUB_TOKEN =
		"github_pat_thisSecretMustNotAppearInTheRunnerScript123456";
	process.env.OPENAI_API_KEY = "sk-worker-secret";
	const script = buildRunnerScript(implementerJob());

	assert.equal(script.includes(process.env.FLEET_GITHUB_TOKEN), false);
	assert.equal(script.includes(process.env.OPENAI_API_KEY), false);
	assert.match(script, /FLEET_GITHUB_TOKEN/);
});

test("resolveFleetRepoUrl throws a clear error when FLEET_REPO_URL is unset", () => {
	delete process.env.FLEET_REPO_URL;
	assert.throws(() => resolveFleetRepoUrl(), /FLEET_REPO_URL is required/);
	process.env.FLEET_REPO_URL = "  https://github.com/owner/pi-fleet.git  ";
	assert.equal(resolveFleetRepoUrl(), "https://github.com/owner/pi-fleet.git");
});

test("buildRunnerScript fails fast instead of emitting `git clone ''` when FLEET_REPO_URL is unset", () => {
	delete process.env.FLEET_REPO_URL;
	assert.throws(
		() => buildRunnerScript(implementerJob()),
		new RegExp(MISSING_FLEET_REPO_URL_ERROR.slice(0, 24)),
	);
});

test("buildRunnerScript anchors Outfitter profile resolution to /work/pi-fleet/profiles", () => {
	process.env.FLEET_REPO_URL = "https://github.com/owner/pi-fleet.git";
	const script = buildRunnerScript(implementerJob());

	// The clone of the pi-fleet pin must use a real URL, never an empty string.
	assert.equal(script.includes("git clone ''"), false);
	assert.match(script, /github\.com\/owner\/pi-fleet\.git/);

	// Profiles are resolved via a user-scope settings file with an absolute path,
	// so `pi-implementer` resolves the profile even when run from /work/repo.
	assert.match(script, /\$HOME\/\.outfitter\/settings\.yml/);
	assert.match(script, /profile_sources:/);
	assert.match(script, /- path: \/work\/pi-fleet\/profiles/);

	// profile.yml extensions (`../extensions/<x>`) are resolved by pi against its
	// cwd (/work/repo) → /work/extensions/..., so the pi-fleet extensions/skills
	// must be symlinked there or the profile fails to load its extension.
	assert.match(script, /ln -sfn \/work\/pi-fleet\/extensions \/work\/extensions/);
	assert.match(script, /ln -sfn \/work\/pi-fleet\/skills \/work\/skills/);
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

test("non-dry-run cast fails fast before sandbox creation when FLEET_REPO_URL is missing", async () => {
	const jobsDir = await mkdtemp(join(tmpdir(), "pi-fleet-jobs-"));
	process.env.FLEET_JOBS_DIR = jobsDir;
	process.env.E2B_API_KEY = "e2b_test_key";
	process.env.FLEET_GITHUB_TOKEN = "ghp_abcdefghijklmnopqrstuvwxyz1234567890";
	process.env.FLEET_E2B_TEMPLATE = "pi-fleet-node22";
	delete process.env.FLEET_REPO_URL;

	try {
		// Real tryCreateSandbox: the FLEET_REPO_URL check must throw before the e2b
		// SDK is imported or any sandbox is created — otherwise the runner would
		// emit `git clone ''` inside a billed sandbox (FLT-4 blocker #1).
		const job = await castJob({
			profile: "implementer",
			brief: "implement FLT-4",
			codeAccess: "clone",
			repo: "owner/repo",
		});

		assert.equal(job.status, "failed");
		assert.equal(job.sandboxId, undefined);
		assert.equal(job.error, MISSING_FLEET_REPO_URL_ERROR);

		const persisted = await readJob(job.jobId);
		assert.equal(persisted.status, "failed");
		assert.equal(persisted.error, MISSING_FLEET_REPO_URL_ERROR);
	} finally {
		await rm(jobsDir, { recursive: true, force: true });
	}
});

interface RecordingSandbox extends RunnableSandbox {
	readonly calls: string[];
	killed: number;
}

function recordingSandbox(opts: {
	sandboxId?: string;
	failOn?: RegExp;
} = {}): RecordingSandbox {
	const calls: string[] = [];
	const sandbox: RecordingSandbox = {
		sandboxId: "sandboxId" in opts ? opts.sandboxId : "sbx-mock",
		calls,
		killed: 0,
		files: {
			async write(path: string) {
				calls.push(`write:${path}`);
			},
		},
		commands: {
			async run(command: string) {
				calls.push(`run:${command}`);
				if (opts.failOn?.test(command)) {
					throw new Error(`command failed: ${command}`);
				}
				return {};
			},
		},
		async kill() {
			sandbox.killed += 1;
		},
	};
	return sandbox;
}

function tryCreateSandboxEnv() {
	process.env.E2B_API_KEY = "e2b_test_key";
	process.env.FLEET_E2B_TEMPLATE = "pi-fleet-node22";
	process.env.FLEET_REPO_URL = "https://github.com/owner/pi-fleet.git";
}

test("tryCreateSandbox chmods /work as root BEFORE writing the runner, then backgrounds it", async () => {
	tryCreateSandboxEnv();
	const sandbox = recordingSandbox();

	const result = await tryCreateSandbox(implementerJob(), async () => sandbox);

	assert.equal(result.sandboxId, "sbx-mock");
	// Exact ordering: root chmod of /work must precede the runner write, and the
	// executable bit + backgrounded runner follow it.
	assert.deepEqual(sandbox.calls, [
		"run:mkdir -p /work && chmod -R a+rwX /work",
		"write:/work/run-job.sh",
		"run:chmod +x /work/run-job.sh",
		"run:bash -lc 'nohup /work/run-job.sh >/work/job.log 2>&1 & echo $! > /work/job.pid'",
	]);
	assert.equal(sandbox.killed, 0);
});

test("tryCreateSandbox kills the sandbox when a setup command fails", async () => {
	tryCreateSandboxEnv();
	const sandbox = recordingSandbox({ failOn: /nohup/ });

	await assert.rejects(
		() => tryCreateSandbox(implementerJob(), async () => sandbox),
		/sbx-mock started but runner setup failed: command failed/,
	);
	assert.equal(sandbox.killed, 1);
});

test("tryCreateSandbox kills and fails clearly when create() yields no sandboxId", async () => {
	tryCreateSandboxEnv();
	const sandbox = recordingSandbox({ sandboxId: undefined });

	await assert.rejects(
		() => tryCreateSandbox(implementerJob(), async () => sandbox),
		(err: Error) =>
			/returned no sandboxId/.test(err.message) &&
			!/started but/.test(err.message),
	);
	// No id to run setup against, so we never issued setup commands…
	assert.deepEqual(sandbox.calls, []);
	// …but we still best-effort killed whatever create() handed back.
	assert.equal(sandbox.killed, 1);
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
