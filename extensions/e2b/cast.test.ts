import assert from "node:assert/strict";
import test from "node:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { castJob, refreshFromSandbox, tryCreateSandbox } from "./cast.ts";
import {
	GITHUB_APP_ID_ENV,
	GITHUB_APP_INSTALLATION_ID_ENV,
	GITHUB_APP_PRIVATE_KEY_ENV,
} from "./githubApp.ts";
import { readJob, writeJob } from "./jobs.ts";
import { DEFAULT_TIMEOUT_MINUTES, type FleetJob } from "./types.ts";

const ORIGINAL_ENV = { ...process.env };

function clearSensitiveEnv() {
	delete process.env.FLEET_GITHUB_TOKEN;
	delete process.env.GH_TOKEN;
	delete process.env.E2B_API_KEY;
	delete process.env[GITHUB_APP_ID_ENV];
	delete process.env[GITHUB_APP_INSTALLATION_ID_ENV];
	delete process.env[GITHUB_APP_PRIVATE_KEY_ENV];
}

// Throwaway RSA keypair generated fresh in-process — never a real App secret.
function generateTestRsaPrivateKey(): string {
	return generateKeyPairSync("rsa", {
		modulusLength: 2048,
		publicKeyEncoding: { type: "spki", format: "pem" },
		privateKeyEncoding: { type: "pkcs1", format: "pem" },
	}).privateKey;
}

interface RecordingSandbox {
	sandboxId?: string;
	calls: string[];
	files: { write(path: string, content: string): Promise<void> };
	commands: { run(command: string, options?: Record<string, unknown>): Promise<unknown> };
	kill(): Promise<void>;
}

function recordingSandbox(): RecordingSandbox {
	const calls: string[] = [];
	return {
		sandboxId: "sbx-app-token",
		calls,
		files: {
			async write(path: string) {
				calls.push(`write:${path}`);
			},
		},
		commands: {
			async run(command: string, options?: Record<string, unknown>) {
				calls.push(`run:${command}`);
				if (command.includes("nohup")) {
					calls.push(`envs:${JSON.stringify((options as { envs?: Record<string, string> })?.envs ?? {})}`);
				}
				return {};
			},
		},
		async kill() {},
	};
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

test("a cast without an explicit timeout uses the 90-minute hard-timeout default (FLT-4 AC #5)", async () => {
	assert.equal(DEFAULT_TIMEOUT_MINUTES, 90);

	const jobsDir = await mkdtemp(join(tmpdir(), "pi-fleet-jobs-"));
	process.env.FLEET_JOBS_DIR = jobsDir;
	process.env.E2B_API_KEY = "e2b_test_key";
	process.env.FLEET_GITHUB_TOKEN = "ghp_abcdefghijklmnopqrstuvwxyz1234567890";

	try {
		const job = await castJob(
			{
				profile: "implementer",
				brief: "implement FLT-4",
				codeAccess: "clone",
				repo: "owner/repo",
				// timeoutMinutes deliberately omitted so the default applies.
			},
			{
				createSandbox: async () => ({
					sandboxId: "sandbox-default-timeout",
					logTail: "sandbox started; runner backgrounded",
				}),
			},
		);

		assert.equal(job.timeoutMinutes, 90);
		const persisted = await readJob(job.jobId);
		assert.equal(persisted.timeoutMinutes, 90);
	} finally {
		await rm(jobsDir, { recursive: true, force: true });
	}
});

test("refreshFromSandbox kills the sandbox and marks the job timeout when result.json never appears past the max-lifetime ceiling", async () => {
	const jobsDir = await mkdtemp(join(tmpdir(), "pi-fleet-jobs-"));
	process.env.FLEET_JOBS_DIR = jobsDir;
	process.env.E2B_API_KEY = "e2b_test_key";

	// createdAt is 200 minutes ago — well past a 90 minute max-lifetime ceiling
	// (pinned explicitly here; the fleet-wide default is 180m so keepalive can
	// extend jobs past the 90m timeoutMinutes sandbox-TTL window — see FLT-8).
	const created = new Date(Date.now() - 200 * 60 * 1000).toISOString();
	const job: FleetJob = await writeJob({
		jobId: "job-timeout",
		profile: "implementer",
		status: "running",
		brief: "long-running brief",
		codeAccess: "clone",
		repo: "owner/repo",
		timeoutMinutes: 90,
		maxLifetimeMinutes: 90,
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
		assert.match(refreshed.error ?? "", /max lifetime of 90 minutes/);

		const persisted = await readJob("job-timeout");
		assert.equal(persisted.status, "timeout");
		assert.match(persisted.error ?? "", /max lifetime of 90 minutes/);
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

test("non-dry-run cast fails clearly before sandbox creation when the GitHub App is only partially configured (FLT-6)", async () => {
	const jobsDir = await mkdtemp(join(tmpdir(), "pi-fleet-jobs-"));
	process.env.FLEET_JOBS_DIR = jobsDir;
	process.env.E2B_API_KEY = "e2b_test_key";
	// A valid PAT is also present — misconfiguration must still be a hard
	// error, never silently masked by falling back to the PAT.
	process.env.FLEET_GITHUB_TOKEN = "ghp_abcdefghijklmnopqrstuvwxyz1234567890";
	process.env[GITHUB_APP_ID_ENV] = "123";
	// installationId and private key deliberately left unset.

	let sandboxCreated = false;
	try {
		const job = await castJob(
			{
				profile: "implementer",
				brief: "implement FLT-6",
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
		assert.equal(job.status, "failed");
		assert.match(job.error ?? "", /partially configured/i);

		const persisted = await readJob(job.jobId);
		assert.equal(persisted.status, "failed");
		assert.match(persisted.error ?? "", /partially configured/i);
	} finally {
		await rm(jobsDir, { recursive: true, force: true });
	}
});

test("tryCreateSandbox injects a minted GitHub App installation token — not the raw PAT — when the App is fully configured (FLT-6)", async () => {
	process.env.E2B_API_KEY = "e2b_test_key";
	process.env.FLEET_E2B_TEMPLATE = "pi-fleet-node22";
	process.env.FLEET_REPO_URL = "https://github.com/owner/pi-fleet.git";
	process.env.GH_TOKEN = "ghp_rawPatMustNotReachSandbox1234567890ab";
	process.env[GITHUB_APP_ID_ENV] = "123";
	process.env[GITHUB_APP_INSTALLATION_ID_ENV] = "456";
	process.env[GITHUB_APP_PRIVATE_KEY_ENV] = generateTestRsaPrivateKey();

	const sandbox = recordingSandbox();
	const job: FleetJob = {
		jobId: "job-app-token",
		profile: "implementer",
		status: "queued",
		brief: "do the thing",
		codeAccess: "pr",
		repo: "owner/repo",
		prNumber: 1,
		timeoutMinutes: 90,
		dryRun: false,
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
	};

	await tryCreateSandbox(job, async () => sandbox, {
		fetchImpl: (async () =>
			new Response(
				JSON.stringify({ token: "ghs_mintedAppToken", expires_at: "2026-01-01T00:00:00Z" }),
				{ status: 201 },
			)) as typeof fetch,
	});

	const envsCall = sandbox.calls.find((c) => c.startsWith("envs:"));
	assert.ok(envsCall, "expected the backgrounded run command to receive envs");
	const envs = JSON.parse(envsCall!.slice("envs:".length));
	assert.equal(envs.FLEET_GITHUB_TOKEN, "ghs_mintedAppToken");
});
