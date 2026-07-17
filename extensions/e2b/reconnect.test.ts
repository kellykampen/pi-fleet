import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { resolveAndRefreshJob } from "./cast.ts";
import { readJob, writeJob } from "./jobs.ts";
import { resolveSandboxApi } from "./sdk.ts";
import type { FleetJob } from "./types.ts";

const ORIGINAL_ENV = { ...process.env };

test.afterEach(() => {
	for (const key of Object.keys(process.env)) {
		if (!(key in ORIGINAL_ENV)) delete process.env[key];
	}
	Object.assign(process.env, ORIGINAL_ENV);
});

async function withTempStore(fn: () => Promise<void>): Promise<void> {
	const dir = await mkdtemp(join(tmpdir(), "pi-fleet-reconnect-"));
	process.env.PI_FLEET_HOME = dir;
	delete process.env.FLEET_CONVEX_URL;
	try {
		await fn();
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

function existingJob(): FleetJob {
	const now = new Date().toISOString();
	return {
		jobId: "job-existing",
		profile: "implementer",
		status: "running",
		brief: "existing brief",
		codeAccess: "clone",
		repo: "owner/repo",
		timeoutMinutes: 90,
		dryRun: false,
		sandboxId: "sandbox-existing",
		createdAt: now,
		updatedAt: now,
	};
}

test("reconnects by sandbox ID and rehydrates a missing local job from live files", async () => {
	await withTempStore(async () => {
		const connected: string[] = [];
		const job = await resolveAndRefreshJob("sandbox-live", {
			now: () => new Date("2026-07-11T10:00:00.000Z"),
			connectSandbox: async (sandboxId) => {
				connected.push(sandboxId);
				return {
					files: {
						async read(path) {
							if (path === "/work/job.log") return "worker still running\n";
							return JSON.stringify({
								jobId: "job-remote",
								status: "succeeded",
								commitSha: "abc123",
								prUrl: "https://github.com/owner/repo/pull/7",
								branch: "fleet/flt-11",
							});
						},
					},
				};
			},
		});

		assert.deepEqual(connected, ["sandbox-live"]);
		assert.equal(job.jobId, "job-remote");
		assert.equal(job.sandboxId, "sandbox-live");
		assert.equal(job.status, "succeeded");
		assert.equal(job.commitSha, "abc123");
		assert.equal(job.logTail, "worker still running\n");

		const persisted = await readJob("job-remote");
		assert.equal(persisted.sandboxId, "sandbox-live");
		assert.equal(persisted.prUrl, "https://github.com/owner/repo/pull/7");
	});
});

test("reconnects before result.json exists and recovers metadata from log and brief files", async () => {
	await withTempStore(async () => {
		const job = await resolveAndRefreshJob("sandbox-running", {
			now: () => new Date("2026-07-11T10:00:00.000Z"),
			connectSandbox: async () => ({
				files: {
					async read(path) {
						if (path === "/work/result.json") throw new Error("not ready");
						if (path === "/work/brief.md") return "original brief";
						return "fleet e2b job job-from-log starting\nsetup complete";
					},
				},
			}),
		});

		assert.equal(job.jobId, "job-from-log");
		assert.equal(job.status, "running");
		assert.equal(job.brief, "original brief");
		assert.match(job.logTail ?? "", /setup complete/);
		assert.equal((await readJob("job-from-log")).sandboxId, "sandbox-running");
	});
});

test("sandbox ID refreshes an existing local job instead of creating a duplicate", async () => {
	await withTempStore(async () => {
		await writeJob(existingJob());
		let connections = 0;
		const job = await resolveAndRefreshJob("sandbox-existing", {
			connectSandbox: async () => {
				connections += 1;
				return {
					files: {
						async read(path) {
							if (path === "/work/result.json") throw new Error("not ready");
							return "fresh logs";
						},
					},
				};
			},
		});

		assert.equal(connections, 1);
		assert.equal(job.jobId, "job-existing");
		assert.equal(job.logTail, "fresh logs");
	});
});

test("SDK resolver supports named, default-wrapped, and direct Sandbox import shapes", () => {
	const connect = async () => ({ ok: true });
	const sandbox = { connect };

	assert.equal(resolveSandboxApi({ Sandbox: sandbox }, "connect"), sandbox);
	assert.equal(
		resolveSandboxApi({ default: { Sandbox: sandbox } }, "connect"),
		sandbox,
	);
	assert.equal(resolveSandboxApi({ default: sandbox }, "connect"), sandbox);
	assert.equal(resolveSandboxApi(sandbox, "connect"), sandbox);
	assert.throws(
		() => resolveSandboxApi({ Sandbox: {} }, "connect"),
		/does not expose Sandbox\.connect/,
	);
});
