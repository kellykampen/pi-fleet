/**
 * pi-fleet E2B extension — project-lead tools for remote implementer casts.
 * Design: https://linear.app/dojoco/document/e2b-v0-design-bf86cf762b0f
 */
import { defineTool, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { newJobId, readJob, updateJob, writeJob } from "./jobs.js";
import {
	DEFAULT_TIMEOUT_MINUTES,
	isTerminal,
	type CastParams,
	type FleetJob,
} from "./types.js";

const FLEET_REPO_DEFAULT =
	process.env.FLEET_REPO_URL?.trim() || "https://github.com/kellykampen/pi-fleet.git";

function textResult(text: string, details: Record<string, unknown> = {}) {
	return {
		content: [{ type: "text" as const, text }],
		details,
	};
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

function requireImplementerCast(params: CastParams): void {
	if (params.profile !== "implementer") {
		throw new Error(`v0 only supports profile "implementer" (got ${params.profile})`);
	}
	if (params.codeAccess === "none") {
		throw new Error('implementer cast requires codeAccess "clone" | "pr" | "branch"');
	}
	if (!params.repo?.trim()) {
		throw new Error("repo is required for implementer casts");
	}
	if (params.codeAccess === "pr" && params.prNumber == null) {
		throw new Error('prNumber is required when codeAccess is "pr"');
	}
	if (params.codeAccess === "branch" && !params.branch?.trim()) {
		throw new Error('branch is required when codeAccess is "branch"');
	}
	if (!params.brief?.trim()) {
		throw new Error("brief is required");
	}
}

function githubTokenPresent(): boolean {
	return Boolean(process.env.FLEET_GITHUB_TOKEN?.trim() || process.env.GH_TOKEN?.trim());
}

function resolveGithubToken(): string | undefined {
	return process.env.FLEET_GITHUB_TOKEN?.trim() || process.env.GH_TOKEN?.trim() || undefined;
}

/** Build the remote runner script (secrets only via env — never embedded). */
function buildRunnerScript(job: FleetJob): string {
	const fleetRepo = FLEET_REPO_DEFAULT;
	const fleetRef = job.fleetRef || "develop";
	const baseBranch = job.baseBranch || "main";
	const provider = job.provider || "";
	const model = job.model || "";
	const modelFlags =
		provider && model
			? ` --provider ${shellQuote(provider)} --model ${shellQuote(model)}`
			: provider
				? ` --provider ${shellQuote(provider)}`
				: model
					? ` --model ${shellQuote(model)}`
					: "";

	let checkout: string;
	const repo = job.repo || "";
	if (job.codeAccess === "pr") {
		checkout = [
			`gh repo clone ${shellQuote(repo)} /work/repo -- --depth 1`,
			"cd /work/repo",
			`gh pr checkout ${Number(job.prNumber)}`,
		].join("\n");
	} else if (job.codeAccess === "branch") {
		checkout = [
			`gh repo clone ${shellQuote(repo)} /work/repo -- --depth 1 --branch ${shellQuote(job.branch || "")}`,
			"cd /work/repo",
		].join("\n");
	} else {
		const newBranch = job.branch || `fleet/${job.jobId.slice(0, 8)}`;
		checkout = [
			`gh repo clone ${shellQuote(repo)} /work/repo -- --depth 1 --branch ${shellQuote(baseBranch)}`,
			"cd /work/repo",
			`git checkout -b ${shellQuote(newBranch)}`,
		].join("\n");
	}

	// Runner is bash. JOB_ID is injected quoted. Brief is a quoted heredoc.
	return `#!/usr/bin/env bash
set -euo pipefail
export JOB_ID=${shellQuote(job.jobId)}
RESULT=/work/result.json
LOG=/work/job.log
mkdir -p /work
exec > >(tee -a "$LOG") 2>&1
echo "fleet e2b job $JOB_ID starting"

cat > /work/brief.md <<'FLEET_BRIEF_EOF'
${job.brief}
FLEET_BRIEF_EOF

# pi-fleet pin
git clone --depth 1 --branch ${shellQuote(fleetRef)} ${shellQuote(fleetRepo)} /work/pi-fleet \\
  || git clone --depth 1 ${shellQuote(fleetRepo)} /work/pi-fleet
export PATH="/work/pi-fleet/bin:$PATH"

# auth for gh/git (token from env — never echo values)
if [ -n "\${FLEET_GITHUB_TOKEN:-}" ]; then
  export GH_TOKEN="\$FLEET_GITHUB_TOKEN"
  git config --global url."https://x-access-token:\${FLEET_GITHUB_TOKEN}@github.com/".insteadOf "https://github.com/"
fi

${checkout}

if command -v pi-implementer >/dev/null 2>&1 || [ -x /work/pi-fleet/bin/pi-implementer ]; then
  PI_IMPL=$(command -v pi-implementer || echo /work/pi-fleet/bin/pi-implementer)
  set +e
  "$PI_IMPL"${modelFlags} -p "$(cat /work/brief.md)"
  EXIT=$?
  set -e
else
  echo "pi-implementer not available in sandbox PATH — install pi + outfitter in the E2B template"
  EXIT=127
fi

export BRANCH=$(git -C /work/repo rev-parse --abbrev-ref HEAD 2>/dev/null || true)
export SHA=$(git -C /work/repo rev-parse HEAD 2>/dev/null || true)
export PR_URL=$(gh pr view --json url -q .url 2>/dev/null || true)
export EXIT
if [ "$EXIT" -eq 0 ]; then export STATUS=succeeded; else export STATUS=failed; fi

if [ ! -f "$RESULT" ]; then
  python3 - <<'PY'
import json, os, datetime
status = os.environ.get("STATUS", "failed")
exit_code = os.environ.get("EXIT", "1")
result = {
  "jobId": os.environ.get("JOB_ID"),
  "profile": "implementer",
  "status": status,
  "commitSha": os.environ.get("SHA") or None,
  "prUrl": os.environ.get("PR_URL") or None,
  "branch": os.environ.get("BRANCH") or None,
  "error": None if status == "succeeded" else f"pi-implementer exited {exit_code}",
  "finishedAt": datetime.datetime.utcnow().isoformat() + "Z",
}
with open("/work/result.json", "w", encoding="utf-8") as f:
  json.dump(result, f, indent=2)
  f.write("\\n")
PY
fi

echo "fleet e2b job $JOB_ID finished status=$STATUS"
exit "$EXIT"
`;
}

async function tryCreateSandbox(job: FleetJob): Promise<{ sandboxId: string; logTail: string }> {
	const apiKey = process.env.E2B_API_KEY?.trim();
	if (!apiKey) {
		throw new Error("E2B_API_KEY is not set");
	}

	const { Sandbox } = await import("e2b");
	const template = process.env.FLEET_E2B_TEMPLATE?.trim() || undefined;
	const timeoutMs = job.timeoutMinutes * 60 * 1000;

	// SDK: Sandbox.create(templateId | opts)
	const sandbox = template
		? await Sandbox.create(template, { timeoutMs, apiKey })
		: await Sandbox.create({ timeoutMs, apiKey });

	const envs: Record<string, string> = {};
	const gh = resolveGithubToken();
	if (gh) envs.FLEET_GITHUB_TOKEN = gh;
	for (const key of [
		"OPENAI_API_KEY",
		"OPENROUTER_API_KEY",
		"ANTHROPIC_API_KEY",
		"XAI_API_KEY",
		"GEMINI_API_KEY",
		"GOOGLE_API_KEY",
		"KIMI_API_KEY",
		"MOONSHOT_API_KEY",
	]) {
		const v = process.env[key]?.trim();
		if (v) envs[key] = v;
	}

	const runner = buildRunnerScript(job);
	await sandbox.files.write("/work/run-job.sh", runner);
	await sandbox.commands.run("chmod +x /work/run-job.sh && mkdir -p /work", { timeoutMs: 60_000 });

	const envExports = Object.entries(envs)
		.map(([k, v]) => `export ${k}=${shellQuote(v)}`)
		.join("\n");
	await sandbox.commands.run(
		`bash -lc ${shellQuote(`${envExports}\nnohup /work/run-job.sh >/work/job.log 2>&1 & echo $! > /work/job.pid`)}`,
		{ timeoutMs: 60_000 },
	);

	return { sandboxId: sandbox.sandboxId, logTail: "sandbox started; runner backgrounded" };
}

async function refreshFromSandbox(job: FleetJob): Promise<FleetJob> {
	if (!job.sandboxId || job.dryRun || isTerminal(job.status)) return job;
	const apiKey = process.env.E2B_API_KEY?.trim();
	if (!apiKey) return job;

	try {
		const { Sandbox } = await import("e2b");
		const sandbox = await Sandbox.connect(job.sandboxId, { apiKey });

		let resultRaw = "";
		try {
			resultRaw = await sandbox.files.read("/work/result.json");
		} catch {
			// not ready
		}

		let logTail = job.logTail || "";
		try {
			const log = await sandbox.files.read("/work/job.log");
			logTail = log.slice(-4000);
		} catch {
			// ignore
		}

		if (resultRaw) {
			const remote = JSON.parse(resultRaw) as Partial<FleetJob>;
			return updateJob(job.jobId, {
				status: (remote.status as FleetJob["status"]) || job.status,
				commitSha: remote.commitSha ?? job.commitSha,
				prUrl: remote.prUrl ?? job.prUrl,
				branch: remote.branch ?? job.branch,
				blockers: remote.blockers ?? job.blockers,
				questions: remote.questions ?? job.questions,
				error: remote.error ?? job.error,
				logTail,
			});
		}

		const created = Date.parse(job.createdAt);
		const limitMs = job.timeoutMinutes * 60 * 1000;
		if (Number.isFinite(created) && Date.now() - created > limitMs) {
			try {
				await sandbox.kill();
			} catch {
				// ignore
			}
			return updateJob(job.jobId, {
				status: "timeout",
				error: `Exceeded timeout of ${job.timeoutMinutes} minutes`,
				logTail,
			});
		}

		if (job.status === "queued") {
			return updateJob(job.jobId, { status: "running", logTail });
		}
		return updateJob(job.jobId, { logTail });
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return updateJob(job.jobId, {
			logTail: `${job.logTail || ""}\n[status probe] ${message}`.slice(-4000),
		});
	}
}

async function castJob(params: CastParams): Promise<FleetJob> {
	requireImplementerCast(params);
	const dryRun = Boolean(params.dryRun) || !process.env.E2B_API_KEY?.trim();
	const now = new Date().toISOString();
	const job: FleetJob = {
		jobId: newJobId(),
		profile: "implementer",
		status: "queued",
		ticketId: params.ticketId,
		brief: params.brief.trim(),
		codeAccess: params.codeAccess,
		repo: params.repo?.trim(),
		baseBranch: params.baseBranch,
		prNumber: params.prNumber,
		branch: params.branch,
		provider: params.provider,
		model: params.model,
		timeoutMinutes: params.timeoutMinutes ?? DEFAULT_TIMEOUT_MINUTES,
		fleetRef: params.fleetRef,
		dryRun,
		createdAt: now,
		updatedAt: now,
	};

	await writeJob(job);

	if (dryRun) {
		return updateJob(job.jobId, {
			status: "running",
			logTail: process.env.E2B_API_KEY?.trim()
				? "dryRun=true: no sandbox created"
				: "E2B_API_KEY missing: dry-run job record only (no sandbox)",
		});
	}

	if (!githubTokenPresent()) {
		return updateJob(job.jobId, {
			status: "failed",
			error: "FLEET_GITHUB_TOKEN (or GH_TOKEN) is required for non-dry-run implementer casts",
		});
	}

	try {
		const { sandboxId, logTail } = await tryCreateSandbox(job);
		return updateJob(job.jobId, { status: "running", sandboxId, logTail });
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return updateJob(job.jobId, { status: "failed", error: message });
	}
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
				if (job.sandboxId && process.env.E2B_API_KEY?.trim()) {
					try {
						const { Sandbox } = await import("e2b");
						const sandbox = await Sandbox.connect(job.sandboxId, {
							apiKey: process.env.E2B_API_KEY.trim(),
						});
						await sandbox.kill();
					} catch (err) {
						const message = err instanceof Error ? err.message : String(err);
						const updated = await updateJob(job.jobId, {
							status: "cancelled",
							error: `cancel requested; sandbox kill error: ${message}`,
						});
						return textResult(JSON.stringify(updated, null, 2), { job: updated });
					}
				}
				const updated = await updateJob(job.jobId, {
					status: "cancelled",
					error: job.dryRun ? "cancelled dry-run job" : "cancelled by project lead",
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
