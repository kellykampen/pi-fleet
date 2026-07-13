/**
 * Minimal fleet job UI. Lists jobs from the *selected* store (Convex when
 * FLEET_CONVEX_URL is set, else local files) filtered by status / project /
 * ticketId, rendering either a terminal table or a self-contained static HTML
 * page.
 *
 * CLI usage (from extensions/e2b):
 *   npm run jobs -- --status running --project acme/web --ticket FLT-7
 *   npm run jobs -- --html > jobs.html
 *
 * The renderers below are pure so they are unit-tested without any store.
 */
import { listJobs } from "./jobs.js";
import { ALL_JOB_STATUSES, isJobStatus } from "./types.js";
import type { FleetJob, JobFilter } from "./types.js";

const COLUMNS: { header: string; value: (j: FleetJob) => string }[] = [
	{ header: "jobId", value: (j) => j.jobId },
	{ header: "status", value: (j) => j.status },
	{ header: "project", value: (j) => j.repo ?? "-" },
	{ header: "ticketId", value: (j) => j.ticketId ?? "-" },
	{ header: "updatedAt", value: (j) => j.updatedAt },
	{
		header: "brief",
		value: (j) =>
			j.brief.length > 60 ? `${j.brief.slice(0, 57)}...` : j.brief,
	},
];

/** Neutralize newlines/control chars (incl. ANSI escapes) so a cell can't break table alignment or inject terminal escapes. */
function sanitizeCell(value: string): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: intentionally matching control chars to strip them.
	return value.replace(/[\u0000-\u001f\u007f]/g, " ");
}

export function renderJobsText(jobs: FleetJob[]): string {
	if (jobs.length === 0) return "No jobs.";
	const rows = jobs.map((j) => COLUMNS.map((c) => sanitizeCell(c.value(j))));
	const headers = COLUMNS.map((c) => c.header);
	const widths = headers.map((h, i) =>
		Math.max(h.length, ...rows.map((r) => r[i].length)),
	);
	const line = (cells: string[]) =>
		cells.map((cell, i) => cell.padEnd(widths[i])).join("  ");
	const out = [line(headers), line(widths.map((w) => "-".repeat(w)))];
	for (const row of rows) out.push(line(row));
	out.push("", `${jobs.length} job(s).`);
	return out.join("\n");
}

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

export function renderJobsHtml(jobs: FleetJob[]): string {
	const head = COLUMNS.map((c) => `<th>${escapeHtml(c.header)}</th>`).join("");
	const body = jobs
		.map(
			(j) =>
				`<tr>${COLUMNS.map(
					(c) => `<td>${escapeHtml(c.value(j))}</td>`,
				).join("")}</tr>`,
		)
		.join("\n");
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>pi-fleet jobs</title>
<style>
  body { font: 14px system-ui, sans-serif; margin: 2rem; }
  table { border-collapse: collapse; width: 100%; }
  th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid #ddd; }
  th { background: #f5f5f5; }
</style>
</head>
<body>
<h1>pi-fleet jobs (${jobs.length})</h1>
<table>
<thead><tr>${head}</tr></thead>
<tbody>
${body || `<tr><td colspan="${COLUMNS.length}">No jobs.</td></tr>`}
</tbody>
</table>
</body>
</html>
`;
}

const VALUE_FLAGS = new Set(["--status", "--project", "--ticket"]);

function assertHasValue(
	arg: string,
	value: string | undefined,
): asserts value is string {
	if (value === undefined || value.startsWith("--")) {
		throw new Error(`${arg} requires a value`);
	}
}

export function parseFilterArgs(argv: string[]): JobFilter {
	const filter: JobFilter = {};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--html") continue;
		if (!VALUE_FLAGS.has(arg)) {
			throw new Error(`Unknown flag: ${arg}`);
		}
		const next = argv[i + 1];
		assertHasValue(arg, next);
		i++;
		if (arg === "--status") {
			if (!isJobStatus(next)) {
				throw new Error(
					`--status must be one of ${ALL_JOB_STATUSES.join(", ")}, got "${next}"`,
				);
			}
			filter.status = next;
		} else if (arg === "--project") {
			filter.repo = next;
		} else {
			filter.ticketId = next;
		}
	}
	return filter;
}

async function main(argv: string[]): Promise<void> {
	const asHtml = argv.includes("--html");
	const filter = parseFilterArgs(argv);
	const jobs = await listJobs(filter);
	process.stdout.write(
		asHtml ? renderJobsHtml(jobs) : `${renderJobsText(jobs)}\n`,
	);
}

// Run as a CLI when invoked directly (not when imported by tests).
if (
	process.argv[1] &&
	(process.argv[1].endsWith("jobs-ui.ts") ||
		process.argv[1].endsWith("jobs-ui.js"))
) {
	main(process.argv.slice(2)).catch((err) => {
		process.stderr.write(`${err instanceof Error ? err.message : err}\n`);
		process.exitCode = 1;
	});
}
