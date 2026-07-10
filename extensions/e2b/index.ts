/**
 * pi-fleet E2B extension — project-lead tools for remote implementer casts.
 * Design: docs/e2b-v0.md
 */
import { defineTool, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { cancelSandbox, castJob, refreshFromSandbox } from "./cast.js";
import { readJob, updateJob } from "./jobs.js";
import {
	DEFAULT_TIMEOUT_MINUTES,
	isTerminal,
	type CastParams,
} from "./types.js";

function textResult(text: string, details: Record<string, unknown> = {}) {
	return {
		content: [{ type: "text" as const, text }],
		details,
	};
}

export default function (pi: ExtensionAPI) {
	pi.registerTool(
		defineTool({
			name: "e2b_cast",
			label: "E2B: cast remote worker",
			description:
				"Start an async E2B job for a worker profile (v0: implementer only). Returns jobId immediately. Uses local job store + E2B sandbox. Prefer dryRun when testing without E2B_API_KEY.",
			promptSnippet: "e2b_cast: async remote implementer cast → jobId",
			parameters: Type.Object({
				profile: Type.Literal("implementer", {
					description: 'Worker profile. v0 only supports "implementer".',
				}),
				brief: Type.String({
					description: "Full brief for the worker (ticket AC, constraints, done-means).",
				}),
				codeAccess: Type.Union(
					[Type.Literal("clone"), Type.Literal("pr"), Type.Literal("branch")],
					{ description: "How the sandbox gets code." },
				),
				repo: Type.String({ description: "GitHub repo owner/name or URL." }),
				baseBranch: Type.Optional(Type.String({ description: "Base branch for clone (default main)." })),
				prNumber: Type.Optional(Type.Number({ description: "PR number when codeAccess=pr." })),
				branch: Type.Optional(
					Type.String({
						description: "Branch name when codeAccess=branch (or new branch name for clone).",
					}),
				),
				ticketId: Type.Optional(Type.String({ description: "Linear ticket id, e.g. ENG-123." })),
				provider: Type.Optional(Type.String({ description: "Model provider override for the worker." })),
				model: Type.Optional(Type.String({ description: "Model id override for the worker." })),
				timeoutMinutes: Type.Optional(
					Type.Number({ description: `Hard timeout minutes (default ${DEFAULT_TIMEOUT_MINUTES}).` }),
				),
				fleetRef: Type.Optional(Type.String({ description: "pi-fleet git ref to pin in the sandbox." })),
				dryRun: Type.Optional(
					Type.Boolean({ description: "If true, only write local job record (no sandbox)." }),
				),
			}),
			async execute(_id, params) {
				const job = await castJob(params as CastParams);
				return textResult(JSON.stringify(job, null, 2), { job });
			},
		}),
	);

	pi.registerTool(
		defineTool({
			name: "e2b_status",
			label: "E2B: job status",
			description: "Read a fleet E2B job by id; probes the sandbox for result.json when running.",
			promptSnippet: "e2b_status: fetch remote job status JSON",
			parameters: Type.Object({
				jobId: Type.String({ description: "Job id returned by e2b_cast." }),
			}),
			async execute(_id, params) {
				let job = await readJob(params.jobId);
				job = await refreshFromSandbox(job);
				return textResult(JSON.stringify(job, null, 2), { job });
			},
		}),
	);

	pi.registerTool(
		defineTool({
			name: "e2b_wait",
			label: "E2B: wait for job",
			description:
				"Poll a job until terminal status (succeeded/failed/timeout/cancelled/needs_input) or wait timeout.",
			promptSnippet: "e2b_wait: block until remote job finishes",
			parameters: Type.Object({
				jobId: Type.String({ description: "Job id returned by e2b_cast." }),
				timeoutMinutes: Type.Optional(
					Type.Number({ description: "Max minutes to wait here (default: job timeoutMinutes)." }),
				),
				pollSeconds: Type.Optional(Type.Number({ description: "Poll interval seconds (default 15)." })),
			}),
			async execute(_id, params, signal) {
				const started = Date.now();
				const pollMs = Math.max(3, Math.floor(params.pollSeconds ?? 15)) * 1000;
				let job = await readJob(params.jobId);
				const waitLimitMs = (params.timeoutMinutes ?? job.timeoutMinutes) * 60 * 1000;

				while (!isTerminal(job.status)) {
					if (signal?.aborted) {
						throw new Error("e2b_wait aborted");
					}
					if (Date.now() - started > waitLimitMs) {
						job = await updateJob(job.jobId, {
							error: job.error || "e2b_wait timed out while job still non-terminal",
						});
						return textResult(JSON.stringify({ waitTimedOut: true, job }, null, 2), {
							waitTimedOut: true,
							job,
						});
					}
					job = await refreshFromSandbox(job);
					if (isTerminal(job.status)) break;
					await new Promise<void>((resolve, reject) => {
						const t = setTimeout(resolve, pollMs);
						signal?.addEventListener(
							"abort",
							() => {
								clearTimeout(t);
								reject(new Error("e2b_wait aborted"));
							},
							{ once: true },
						);
					});
					job = await readJob(params.jobId);
				}

				return textResult(JSON.stringify(job, null, 2), { job });
			},
		}),
	);

	pi.registerTool(
		defineTool({
			name: "e2b_cancel",
			label: "E2B: cancel job",
			description: "Kill the sandbox (if any) and mark the job cancelled.",
			promptSnippet: "e2b_cancel: stop remote job",
			parameters: Type.Object({
				jobId: Type.String({ description: "Job id returned by e2b_cast." }),
			}),
			async execute(_id, params) {
				const job = await readJob(params.jobId);
				if (isTerminal(job.status)) {
					return textResult(JSON.stringify(job, null, 2), { job, alreadyTerminal: true });
				}
				const killError = await cancelSandbox(job);
				const updated = await updateJob(job.jobId, {
					status: "cancelled",
					error: killError
						? `cancel requested; sandbox kill error: ${killError}`
						: job.dryRun
							? "cancelled dry-run job"
							: "cancelled by project lead",
				});
				return textResult(JSON.stringify(updated, null, 2), { job: updated });
			},
		}),
	);

	pi.registerTool(
		defineTool({
			name: "e2b_logs",
			label: "E2B: job logs",
			description: "Return the latest log tail for a job (from local record and/or sandbox).",
			promptSnippet: "e2b_logs: tail remote job logs",
			parameters: Type.Object({
				jobId: Type.String({ description: "Job id returned by e2b_cast." }),
			}),
			async execute(_id, params) {
				const job = await refreshFromSandbox(await readJob(params.jobId));
				const text = job.logTail || "(no logs yet)";
				return textResult(text, { jobId: job.jobId, status: job.status });
			},
		}),
	);
}
