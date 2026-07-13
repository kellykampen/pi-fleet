import assert from "node:assert/strict";
import test from "node:test";

import { parseFilterArgs, renderJobsHtml, renderJobsText } from "./jobs-ui.ts";
import type { FleetJob } from "./types.ts";

function job(overrides: Partial<FleetJob> = {}): FleetJob {
	return {
		jobId: "job-1",
		profile: "implementer",
		status: "running",
		ticketId: "FLT-7",
		brief: "brief",
		codeAccess: "clone",
		repo: "acme/web",
		timeoutMinutes: 90,
		dryRun: false,
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		...overrides,
	};
}

test("renderJobsText lists status, project, and ticketId per job", () => {
	const out = renderJobsText([
		job({ jobId: "a", status: "running", repo: "acme/web", ticketId: "FLT-1" }),
		job({
			jobId: "b",
			status: "succeeded",
			repo: "acme/api",
			ticketId: "FLT-2",
		}),
	]);
	assert.match(out, /a/);
	assert.match(out, /running/);
	assert.match(out, /acme\/web/);
	assert.match(out, /FLT-1/);
	assert.match(out, /b/);
	assert.match(out, /succeeded/);
	assert.match(out, /acme\/api/);
	assert.match(out, /FLT-2/);
});

test("renderJobsText reports an empty list", () => {
	assert.match(renderJobsText([]), /no jobs/i);
});

test("renderJobsHtml renders a row per job and escapes HTML", () => {
	const html = renderJobsHtml([
		job({ jobId: "a", brief: "<script>alert(1)</script>" }),
	]);
	assert.match(html, /<table/);
	assert.match(html, /acme\/web/);
	assert.match(html, /FLT-7/);
	// The dangerous brief must be escaped, not present as a live tag.
	assert.doesNotMatch(html, /<script>alert/);
	assert.match(html, /&lt;script&gt;/);
});

test("parseFilterArgs maps --status/--project/--ticket to a JobFilter", () => {
	assert.deepEqual(
		parseFilterArgs([
			"--status",
			"running",
			"--project",
			"acme/web",
			"--ticket",
			"FLT-7",
		]),
		{ status: "running", repo: "acme/web", ticketId: "FLT-7" },
	);
	assert.deepEqual(parseFilterArgs([]), {});
});

test("parseFilterArgs ignores --html", () => {
	assert.deepEqual(parseFilterArgs(["--html", "--status", "running"]), {
		status: "running",
	});
});

test("parseFilterArgs rejects an invalid --status value", () => {
	assert.throws(() => parseFilterArgs(["--status", "bogus"]), /--status/);
});

test("parseFilterArgs rejects a missing flag value", () => {
	assert.throws(() => parseFilterArgs(["--status"]), /requires a value/);
	assert.throws(
		() => parseFilterArgs(["--status", "--project", "acme/web"]),
		/requires a value/,
	);
});

test("parseFilterArgs rejects an unknown flag", () => {
	assert.throws(() => parseFilterArgs(["--bogus", "x"]), /Unknown flag/);
});

test("renderJobsText sanitizes control characters so a job can't break the table", () => {
	const out = renderJobsText([
		job({ jobId: "a", brief: "line1\nline2\tend\x1b[31mred\x1b[0m" }),
	]);
	// header + separator + exactly one row per job + blank + summary line.
	assert.equal(out.split("\n").length, 5);
	assert.doesNotMatch(out, /\t/);
	assert.doesNotMatch(out, /\x1b/);
	assert.match(out, /line1 line2 end \[31mred \[0m/);
});
