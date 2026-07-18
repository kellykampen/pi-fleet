import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
	cancelSandbox,
	castJob,
	refreshFromSandbox,
	startKeepalive,
	stopKeepalive,
} from "./cast.ts";
import { readJob, updateJob, writeJob } from "./jobs.ts";
import { DEFAULT_MAX_LIFETIME_MINUTES, type FleetJob } from "./types.ts";

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

test.beforeEach(clearSensitiveEnv);
test.afterEach(restoreEnv);

async function withTempStore(fn: () => Promise<void>): Promise<void> {
	const dir = await mkdtemp(join(tmpdir(), "pi-fleet-keepalive-"));
	process.env.PI_FLEET_HOME = dir;
	delete process.env.FLEET_CONVEX_URL;
	try {
		await fn();
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

/** Fake interval harness: captures the tick fn so tests can drive it deterministically. */
function fakeTimers() {
	let tickFn: (() => unknown) | undefined;
	const cleared: unknown[] = [];
	const registered: unknown[] = [];
	return {
		setIntervalFn: (fn: () => unknown, _ms: number) => {
			tickFn = fn;
			const handle = { id: registered.length };
			registered.push(handle);
			return handle;
		},
		clearIntervalFn: (h: unknown) => {
			cleared.push(h);
		},
		tick: async () => {
			await tickFn?.();
		},
		wasRegistered: () => registered.length > 0,
		wasCleared: () => cleared.length > 0,
	};
}

function baseJob(overrides: Partial<FleetJob> = {}): FleetJob {
	const now = new Date().toISOString();
	return {
		jobId: overrides.jobId ?? "job-ka",
		profile: "implementer",
		status: "running",
		brief: "brief",
		codeAccess: "clone",
		repo: "owner/repo",
		timeoutMinutes: 90,
		dryRun: false,
		sandboxId: "sandbox-ka",
		createdAt: now,
		updatedAt: now,
		...overrides,
	};
}

test("DEFAULT_MAX_LIFETIME_MINUTES defaults to 3 hours", () => {
	assert.equal(DEFAULT_MAX_LIFETIME_MINUTES, 180);
});

test("e2b_cast (castJob) starts a keepalive that extends the sandbox timeout on tick", async () => {
	await withTempStore(async () => {
		process.env.E2B_API_KEY = "e2b_test_key";
		process.env.FLEET_GITHUB_TOKEN = "ghp_abcdefghijklmnopqrstuvwxyz1234567890";
		const timers = fakeTimers();
		const extendCalls: number[] = [];

		const job = await castJob(
			{
				profile: "implementer",
				brief: "implement FLT-8",
				codeAccess: "clone",
				repo: "owner/repo",
				timeoutMinutes: 90,
			},
			{
				createSandbox: async () => ({
					sandboxId: "sandbox-ka",
					logTail: "sandbox started; runner backgrounded",
				}),
				connectSandbox: async () => ({
					files: {
						async read() {
							throw new Error("not ready");
						},
					},
					async setTimeout(ms: number) {
						extendCalls.push(ms);
					},
				}),
				setIntervalFn: timers.setIntervalFn,
				clearIntervalFn: timers.clearIntervalFn,
			},
		);

		try {
			assert.equal(job.status, "running");
			assert.equal(timers.wasRegistered(), true);

			const beforeTick = Date.now();
			await timers.tick();

			assert.deepEqual(extendCalls, [90 * 60 * 1000]);
			const persisted = await readJob(job.jobId);
			assert.ok(persisted.lastExtendedAt, "lastExtendedAt should be set");
			assert.ok(
				Date.parse(persisted.lastExtendedAt as string) >= beforeTick,
				"lastExtendedAt should reflect the tick's timestamp",
			);
		} finally {
			stopKeepalive(job.jobId);
		}
	});
});

test("keepalive stops extending once the job reaches a terminal status", async () => {
	await withTempStore(async () => {
		const timers = fakeTimers();
		let extendCalls = 0;
		const job = await writeJob(baseJob({ jobId: "job-terminal-stop" }));

		startKeepalive(job.jobId, {
			setIntervalFn: timers.setIntervalFn,
			clearIntervalFn: timers.clearIntervalFn,
			connectSandbox: async () => ({
				files: {
					async read() {
						throw new Error("not ready");
					},
				},
				async setTimeout() {
					extendCalls += 1;
				},
			}),
		});

		await updateJob(job.jobId, { status: "succeeded" });
		await timers.tick();

		assert.equal(extendCalls, 0);
		assert.equal(timers.wasCleared(), true);
	});
});

test("keepalive stops extending once the max-lifetime ceiling is reached", async () => {
	await withTempStore(async () => {
		const timers = fakeTimers();
		let extendCalls = 0;
		const created = new Date("2026-07-13T00:00:00.000Z");
		const job = await writeJob(
			baseJob({
				jobId: "job-max-lifetime",
				createdAt: created.toISOString(),
				maxLifetimeMinutes: 180,
			}),
		);

		startKeepalive(job.jobId, {
			setIntervalFn: timers.setIntervalFn,
			clearIntervalFn: timers.clearIntervalFn,
			connectSandbox: async () => ({
				files: {
					async read() {
						throw new Error("not ready");
					},
				},
				async setTimeout() {
					extendCalls += 1;
				},
			}),
			now: () => new Date(created.getTime() + 181 * 60 * 1000),
		});

		await timers.tick();

		assert.equal(extendCalls, 0);
		assert.equal(timers.wasCleared(), true);
	});
});

test("keepalive extends and records lastExtendedAt when still under the ceiling", async () => {
	await withTempStore(async () => {
		const timers = fakeTimers();
		const extendCalls: number[] = [];
		const created = new Date("2026-07-13T00:00:00.000Z");
		const job = await writeJob(
			baseJob({
				jobId: "job-extend",
				createdAt: created.toISOString(),
				timeoutMinutes: 45,
			}),
		);

		startKeepalive(job.jobId, {
			setIntervalFn: timers.setIntervalFn,
			clearIntervalFn: timers.clearIntervalFn,
			connectSandbox: async () => ({
				files: {
					async read() {
						throw new Error("not ready");
					},
				},
				async setTimeout(ms: number) {
					extendCalls.push(ms);
				},
			}),
			now: () => new Date(created.getTime() + 30 * 60 * 1000),
		});

		await timers.tick();

		assert.deepEqual(extendCalls, [45 * 60 * 1000]);
		assert.equal(timers.wasCleared(), false);
		const persisted = await readJob(job.jobId);
		assert.equal(
			persisted.lastExtendedAt,
			new Date(created.getTime() + 30 * 60 * 1000).toISOString(),
		);

		stopKeepalive(job.jobId);
	});
});

test("cancelSandbox stops an active keepalive immediately", async () => {
	await withTempStore(async () => {
		const timers = fakeTimers();
		const job = await writeJob(baseJob({ jobId: "job-cancel" }));

		startKeepalive(job.jobId, {
			setIntervalFn: timers.setIntervalFn,
			clearIntervalFn: timers.clearIntervalFn,
			connectSandbox: async () => ({
				files: {
					async read() {
						throw new Error("not ready");
					},
				},
			}),
		});

		await cancelSandbox(job);

		assert.equal(timers.wasCleared(), true);
	});
});

test("refreshFromSandbox stops an active keepalive as soon as a terminal result appears", async () => {
	await withTempStore(async () => {
		const timers = fakeTimers();
		const job = await writeJob(baseJob({ jobId: "job-refresh-terminal" }));

		startKeepalive(job.jobId, {
			setIntervalFn: timers.setIntervalFn,
			clearIntervalFn: timers.clearIntervalFn,
			connectSandbox: async () => ({
				files: {
					async read() {
						throw new Error("not ready");
					},
				},
			}),
		});

		await refreshFromSandbox(job, {
			connectSandbox: async () => ({
				files: {
					async read(path: string) {
						if (path === "/work/result.json") {
							return JSON.stringify({ status: "succeeded" });
						}
						return "";
					},
				},
				async kill() {},
			}),
		});

		assert.equal(timers.wasCleared(), true);
	});
});

test("refreshFromSandbox uses maxLifetimeMinutes (not timeoutMinutes) as the runaway-job ceiling", async () => {
	await withTempStore(async () => {
		// 100 minutes elapsed: past the 90-minute timeoutMinutes window, but well
		// under the default 180-minute max-lifetime ceiling that keepalive relies on.
		const created = new Date(Date.now() - 100 * 60 * 1000).toISOString();
		const job = await writeJob(
			baseJob({
				jobId: "job-still-alive",
				timeoutMinutes: 90,
				createdAt: created,
			}),
		);

		let killed = false;
		const refreshed = await refreshFromSandbox(job, {
			connectSandbox: async () => ({
				files: {
					async read() {
						throw new Error("not ready");
					},
				},
				async kill() {
					killed = true;
				},
			}),
		});

		assert.equal(killed, false);
		assert.notEqual(refreshed.status, "timeout");
	});
});

test("castJob persists a per-cast maxLifetimeMinutes override and refreshFromSandbox enforces it", async () => {
	await withTempStore(async () => {
		process.env.E2B_API_KEY = "e2b_test_key";
		process.env.FLEET_GITHUB_TOKEN = "ghp_abcdefghijklmnopqrstuvwxyz1234567890";

		const job = await castJob(
			{
				profile: "implementer",
				brief: "implement FLT-8",
				codeAccess: "clone",
				repo: "owner/repo",
				timeoutMinutes: 90,
				maxLifetimeMinutes: 45,
			},
			{
				createSandbox: async () => ({
					sandboxId: "sandbox-custom-ceiling",
					logTail: "sandbox started; runner backgrounded",
				}),
			},
		);
		stopKeepalive(job.jobId);

		// Persisted on cast, not silently dropped.
		assert.equal(job.maxLifetimeMinutes, 45);
		const persisted = await readJob(job.jobId);
		assert.equal(persisted.maxLifetimeMinutes, 45);

		// 50 minutes elapsed: past the 45-minute per-cast ceiling, but under both
		// the 90-minute timeoutMinutes window and the 180-minute fleet default —
		// only a job that actually reads maxLifetimeMinutes off the record dies here.
		await writeJob({
			...persisted,
			createdAt: new Date(Date.now() - 50 * 60 * 1000).toISOString(),
		});

		let killed = false;
		const refreshed = await refreshFromSandbox(await readJob(job.jobId), {
			connectSandbox: async () => ({
				files: {
					async read() {
						throw new Error("not ready");
					},
				},
				async kill() {
					killed = true;
				},
			}),
		});

		assert.equal(killed, true);
		assert.equal(refreshed.status, "timeout");
		assert.match(refreshed.error ?? "", /max lifetime of 45 minutes/);
	});
});
