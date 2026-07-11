import assert from "node:assert/strict";
import test from "node:test";

import { ConvexJobStore, isConvexConfigured } from "./convexStore.ts";
import { getJobStore } from "./jobs.ts";
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

function fullJob(overrides: Partial<FleetJob> = {}): FleetJob {
	return {
		jobId: "job-1",
		profile: "implementer",
		status: "running",
		ticketId: "FLT-7",
		brief: "implement the convex store",
		codeAccess: "clone",
		repo: "acme/web",
		baseBranch: "develop",
		branch: "flt-7",
		provider: "anthropic",
		model: "claude",
		timeoutMinutes: 90,
		dryRun: false,
		sandboxId: "sbx-1",
		commandsRun: [{ cmd: "npm test", exit: 0 }],
		artifacts: ["dist/out.txt"],
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		...overrides,
	};
}

/** A fake fetch that records calls and replays queued JSON responses. */
function fakeFetch(responses: unknown[]) {
	const calls: { url: string; body: any; headers: any }[] = [];
	let i = 0;
	const impl = async (url: string, init: any) => {
		calls.push({
			url,
			body: JSON.parse(init.body),
			headers: init.headers,
		});
		const value = responses[i++];
		return {
			ok: true,
			status: 200,
			async json() {
				return { status: "success", value };
			},
		} as any;
	};
	return { impl, calls };
}

test("isConvexConfigured reflects FLEET_CONVEX_URL", () => {
	delete process.env.FLEET_CONVEX_URL;
	assert.equal(isConvexConfigured(), false);
	process.env.FLEET_CONVEX_URL = "https://x.convex.cloud";
	assert.equal(isConvexConfigured(), true);
	process.env.FLEET_CONVEX_URL = "   ";
	assert.equal(isConvexConfigured(), false);
});

test("getJobStore returns a ConvexJobStore when FLEET_CONVEX_URL is set", () => {
	process.env.FLEET_CONVEX_URL = "https://x.convex.cloud";
	assert.ok(getJobStore() instanceof ConvexJobStore);
	delete process.env.FLEET_CONVEX_URL;
	assert.ok(!(getJobStore() instanceof ConvexJobStore));
});

test("put issues a jobs:put mutation with the job and bearer token", async () => {
	const { impl, calls } = fakeFetch([null]);
	const store = new ConvexJobStore({
		url: "https://x.convex.cloud/",
		token: "secret-token",
		fetchImpl: impl,
	});
	const job = fullJob();
	await store.put(job);

	assert.equal(calls.length, 1);
	assert.equal(calls[0].url, "https://x.convex.cloud/api/mutation");
	assert.equal(calls[0].body.path, "jobs:put");
	assert.deepEqual(calls[0].body.args, { job });
	assert.equal(calls[0].headers.Authorization, "Bearer secret-token");
});

test("get issues a jobs:get query and strips convex system fields", async () => {
	const stored = {
		...fullJob(),
		_id: "convex-doc-id",
		_creationTime: 123456,
	};
	const { impl, calls } = fakeFetch([stored]);
	const store = new ConvexJobStore({
		url: "https://x.convex.cloud",
		fetchImpl: impl,
	});

	const job = await store.get("job-1");

	assert.equal(calls[0].url, "https://x.convex.cloud/api/query");
	assert.equal(calls[0].body.path, "jobs:get");
	assert.deepEqual(calls[0].body.args, { jobId: "job-1" });
	assert.ok(job);
	assert.equal((job as any)._id, undefined);
	assert.equal((job as any)._creationTime, undefined);
	assert.deepEqual(job, fullJob());
});

test("get returns null when the query yields null", async () => {
	const { impl } = fakeFetch([null]);
	const store = new ConvexJobStore({
		url: "https://x.convex.cloud",
		fetchImpl: impl,
	});
	assert.equal(await store.get("missing"), null);
});

test("list passes the filter as query args and returns newest-first", async () => {
	const rows = [
		{ ...fullJob({ jobId: "a", createdAt: "2026-01-01T00:00:00.000Z" }) },
		{ ...fullJob({ jobId: "b", createdAt: "2026-01-03T00:00:00.000Z" }) },
	];
	const { impl, calls } = fakeFetch([rows]);
	const store = new ConvexJobStore({
		url: "https://x.convex.cloud",
		fetchImpl: impl,
	});

	const jobs = await store.list({ status: "running", repo: "acme/web" });

	assert.equal(calls[0].url, "https://x.convex.cloud/api/query");
	assert.equal(calls[0].body.path, "jobs:list");
	assert.deepEqual(calls[0].body.args, {
		status: "running",
		repo: "acme/web",
	});
	assert.deepEqual(
		jobs.map((j) => j.jobId),
		["b", "a"],
	);
});

test("a Convex error response is surfaced, not swallowed", async () => {
	const store = new ConvexJobStore({
		url: "https://x.convex.cloud",
		fetchImpl: async () =>
			({
				ok: true,
				status: 200,
				async json() {
					return { status: "error", errorMessage: "boom" };
				},
			}) as any,
	});
	await assert.rejects(() => store.get("job-1"), /boom/);
});

test("a non-2xx HTTP response is surfaced", async () => {
	const store = new ConvexJobStore({
		url: "https://x.convex.cloud",
		fetchImpl: async () =>
			({
				ok: false,
				status: 500,
				async text() {
					return "internal error";
				},
			}) as any,
	});
	await assert.rejects(() => store.get("job-1"), /500/);
});
