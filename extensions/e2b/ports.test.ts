import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeJob } from "./jobs.js";
import { resolvePortUrl } from "./ports.js";
import type { FleetJob } from "./types.js";

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

async function withJobsDir(fn: (jobsDir: string) => Promise<void>) {
	const jobsDir = await mkdtemp(join(tmpdir(), "pi-fleet-jobs-"));
	process.env.PI_FLEET_HOME = jobsDir;
	try {
		await fn(jobsDir);
	} finally {
		await rm(jobsDir, { recursive: true, force: true });
	}
}

function baseJob(overrides: Partial<FleetJob> = {}): FleetJob {
	const now = new Date().toISOString();
	return {
		jobId: "job-1",
		profile: "implementer",
		status: "running",
		brief: "brief",
		codeAccess: "clone",
		repo: "owner/repo",
		timeoutMinutes: 90,
		dryRun: false,
		sandboxId: "sandbox-abc",
		createdAt: now,
		updatedAt: now,
		...overrides,
	};
}

test("resolves the public URL for a port on a running sandbox given a jobId", async () => {
	await withJobsDir(async () => {
		await writeJob(baseJob());

		const result = await resolvePortUrl(
			{ jobId: "job-1", port: 3000 },
			{
				connectSandbox: async (sandboxId) => {
					assert.equal(sandboxId, "sandbox-abc");
					return {
						async isRunning() {
							return true;
						},
						getHost(port) {
							return `${port}-sandbox-abc.e2b.app`;
						},
					};
				},
				probe: async (url) => {
					assert.equal(url, "https://3000-sandbox-abc.e2b.app");
					return { ok: true, status: 200 };
				},
			},
		);

		assert.equal(result.url, "https://3000-sandbox-abc.e2b.app");
		assert.equal(result.sandboxId, "sandbox-abc");
		assert.equal(result.port, 3000);
	});
});

test("resolves the public URL directly from a sandboxId, without a job store", async () => {
	const result = await resolvePortUrl(
		{ sandboxId: "sandbox-xyz", port: 8080 },
		{
			connectSandbox: async () => ({
				async isRunning() {
					return true;
				},
				getHost(port) {
					return `${port}-sandbox-xyz.e2b.app`;
				},
			}),
			probe: async () => ({ ok: true, status: 200 }),
		},
	);

	assert.equal(result.url, "https://8080-sandbox-xyz.e2b.app");
});

test("errors when neither jobId nor sandboxId is provided", async () => {
	await assert.rejects(
		() => resolvePortUrl({ port: 3000 }),
		/either jobId or sandboxId is required/,
	);
});

test("errors on an invalid port number", async () => {
	await assert.rejects(
		() => resolvePortUrl({ sandboxId: "sandbox-abc", port: 0 }),
		/invalid port/,
	);
	await assert.rejects(
		() => resolvePortUrl({ sandboxId: "sandbox-abc", port: 70000 }),
		/invalid port/,
	);
});

test("errors when the job never got a sandbox (dry run)", async () => {
	await withJobsDir(async () => {
		await writeJob(baseJob({ dryRun: true, sandboxId: undefined, status: "running" }));

		await assert.rejects(
			() => resolvePortUrl({ jobId: "job-1", port: 3000 }),
			/no live sandbox/,
		);
	});
});

test("errors when the job's sandbox already reached a terminal status", async () => {
	await withJobsDir(async () => {
		await writeJob(baseJob({ status: "failed", error: "boom" }));

		await assert.rejects(
			() => resolvePortUrl({ jobId: "job-1", port: 3000 }),
			/sandbox is not running \(status: failed\)/,
		);
	});
});

test("errors clearly when the sandbox reports it is not running", async () => {
	await withJobsDir(async () => {
		await writeJob(baseJob());

		await assert.rejects(
			() =>
				resolvePortUrl(
					{ jobId: "job-1", port: 3000 },
					{
						connectSandbox: async () => ({
							async isRunning() {
								return false;
							},
							getHost(port) {
								return `${port}-sandbox-abc.e2b.app`;
							},
						}),
					},
				),
			/sandbox sandbox-abc is not running/,
		);
	});
});

test("errors clearly when connecting to the sandbox fails", async () => {
	await withJobsDir(async () => {
		await writeJob(baseJob());

		await assert.rejects(
			() =>
				resolvePortUrl(
					{ jobId: "job-1", port: 3000 },
					{
						connectSandbox: async () => {
							throw new Error("sandbox not found");
						},
					},
				),
			/sandbox sandbox-abc is not running or unreachable: sandbox not found/,
		);
	});
});

test("errors clearly when the port has no listener (proxy probe fails)", async () => {
	await withJobsDir(async () => {
		await writeJob(baseJob());

		await assert.rejects(
			() =>
				resolvePortUrl(
					{ jobId: "job-1", port: 9999 },
					{
						connectSandbox: async () => ({
							async isRunning() {
								return true;
							},
							getHost(port) {
								return `${port}-sandbox-abc.e2b.app`;
							},
						}),
						probe: async () => ({
							ok: false,
							status: 502,
							error: "sandbox proxy returned 502 (no service listening on this port)",
						}),
					},
				),
			/port 9999 on sandbox sandbox-abc is not open/,
		);
	});
});

test("unknown jobId surfaces a clear job lookup error", async () => {
	await withJobsDir(async () => {
		await assert.rejects(
			() => resolvePortUrl({ jobId: "no-such-job", port: 3000 }),
			/Unknown jobId: no-such-job/,
		);
	});
});
