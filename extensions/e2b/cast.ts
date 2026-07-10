import { newJobId, updateJob, writeJob } from "./jobs.js";
import {
	buildRunnerScript,
	collectWorkerEnv,
	githubTokenPresent,
	sanitizeSecrets,
} from "./secrets.js";
import {
	DEFAULT_TIMEOUT_MINUTES,
	isTerminal,
	type CastParams,
	type FleetJob,
} from "./types.js";

export const MISSING_GITHUB_TOKEN_ERROR =
	"FLEET_GITHUB_TOKEN (or GH_TOKEN) is required for non-dry-run implementer casts";

interface SandboxLike {
	files: {
		read(path: string): Promise<string>;
		write?(path: string, content: string): Promise<void>;
	};
	commands?: {
		run(command: string, options?: Record<string, unknown>): Promise<unknown>;
	};
	sandboxId?: string;
	kill?(): Promise<void>;
}

export interface SandboxStartResult {
	sandboxId: string;
	logTail: string;
}

export interface CastDependencies {
	createSandbox?: (job: FleetJob) => Promise<SandboxStartResult>;
}

export interface RefreshDependencies {
	connectSandbox?: (sandboxId: string) => Promise<SandboxLike>;
}

export function requireImplementerCast(params: CastParams): void {
	if (params.profile !== "implementer") {
		throw new Error(
			`v0 only supports profile "implementer" (got ${params.profile})`,
		);
	}
	if (params.codeAccess === "none") {
		throw new Error(
			'implementer cast requires codeAccess "clone" | "pr" | "branch"',
		);
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

async function connectSandboxDefault(sandboxId: string): Promise<SandboxLike> {
	const apiKey = process.env.E2B_API_KEY?.trim();
	if (!apiKey) {
		throw new Error("E2B_API_KEY is not set");
	}
	const { Sandbox } = await import("e2b");
	return Sandbox.connect(sandboxId, { apiKey }) as Promise<SandboxLike>;
}

export async function tryCreateSandbox(
	job: FleetJob,
): Promise<SandboxStartResult> {
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

	const runner = buildRunnerScript(job);
	await sandbox.files.write("/work/run-job.sh", runner);
	await sandbox.commands.run("chmod +x /work/run-job.sh && mkdir -p /work", {
		timeoutMs: 60_000,
	});

	await sandbox.commands.run(
		"bash -lc 'nohup /work/run-job.sh >/work/job.log 2>&1 & echo $! > /work/job.pid'",
		{
			timeoutMs: 60_000,
			envs: collectWorkerEnv(),
		},
	);

	return {
		sandboxId: sandbox.sandboxId,
		logTail: "sandbox started; runner backgrounded",
	};
}

function sanitizeJobPatch<T extends Partial<FleetJob>>(patch: T): T {
	return sanitizeObject(patch) as T;
}

function sanitizeObject(value: unknown): unknown {
	if (typeof value === "string") return sanitizeSecrets(value);
	if (Array.isArray(value)) return value.map((item) => sanitizeObject(item));
	if (value && typeof value === "object") {
		const entries = Object.entries(value).map(([key, item]) => [
			key,
			sanitizeObject(item),
		]);
		return Object.fromEntries(entries);
	}
	return value;
}

export async function refreshFromSandbox(
	job: FleetJob,
	deps: RefreshDependencies = {},
): Promise<FleetJob> {
	if (!job.sandboxId || job.dryRun || isTerminal(job.status)) return job;
	const apiKey = process.env.E2B_API_KEY?.trim();
	if (!apiKey && !deps.connectSandbox) return job;

	try {
		const sandbox = deps.connectSandbox
			? await deps.connectSandbox(job.sandboxId)
			: await connectSandboxDefault(job.sandboxId);

		let resultRaw = "";
		try {
			resultRaw = await sandbox.files.read("/work/result.json");
		} catch {
			// not ready
		}

		let logTail = job.logTail || "";
		try {
			const log = await sandbox.files.read("/work/job.log");
			logTail = sanitizeSecrets(log).slice(-4000);
		} catch {
			// ignore
		}

		if (resultRaw) {
			const remote = sanitizeObject(JSON.parse(resultRaw)) as Partial<FleetJob>;
			return updateJob(
				job.jobId,
				sanitizeJobPatch({
					status: (remote.status as FleetJob["status"]) || job.status,
					commitSha: remote.commitSha ?? job.commitSha,
					prUrl: remote.prUrl ?? job.prUrl,
					branch: remote.branch ?? job.branch,
					commandsRun: remote.commandsRun ?? job.commandsRun,
					blockers: remote.blockers ?? job.blockers,
					questions: remote.questions ?? job.questions,
					artifacts: remote.artifacts ?? job.artifacts,
					error: remote.error ?? job.error,
					logTail,
				}),
			);
		}

		const created = Date.parse(job.createdAt);
		const limitMs = job.timeoutMinutes * 60 * 1000;
		if (Number.isFinite(created) && Date.now() - created > limitMs) {
			try {
				await sandbox.kill?.();
			} catch {
				// ignore
			}
			return updateJob(
				job.jobId,
				sanitizeJobPatch({
					status: "timeout",
					error: `Exceeded timeout of ${job.timeoutMinutes} minutes`,
					logTail,
				}),
			);
		}

		if (job.status === "queued") {
			return updateJob(
				job.jobId,
				sanitizeJobPatch({ status: "running", logTail }),
			);
		}
		return updateJob(job.jobId, sanitizeJobPatch({ logTail }));
	} catch (err) {
		const message = sanitizeSecrets(
			err instanceof Error ? err.message : String(err),
		);
		return updateJob(
			job.jobId,
			sanitizeJobPatch({
				logTail: `${job.logTail || ""}\n[status probe] ${message}`.slice(-4000),
			}),
		);
	}
}

export async function castJob(
	params: CastParams,
	deps: CastDependencies = {},
): Promise<FleetJob> {
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
		return updateJob(
			job.jobId,
			sanitizeJobPatch({
				status: "running",
				logTail: process.env.E2B_API_KEY?.trim()
					? "dryRun=true: no sandbox created"
					: "E2B_API_KEY missing: dry-run job record only (no sandbox)",
			}),
		);
	}

	if (!githubTokenPresent()) {
		return updateJob(
			job.jobId,
			sanitizeJobPatch({
				status: "failed",
				error: MISSING_GITHUB_TOKEN_ERROR,
			}),
		);
	}

	try {
		const { sandboxId, logTail } = await (
			deps.createSandbox ?? tryCreateSandbox
		)(job);
		return updateJob(
			job.jobId,
			sanitizeJobPatch({ status: "running", sandboxId, logTail }),
		);
	} catch (err) {
		const message = sanitizeSecrets(
			err instanceof Error ? err.message : String(err),
		);
		return updateJob(
			job.jobId,
			sanitizeJobPatch({ status: "failed", error: message }),
		);
	}
}

export async function cancelSandbox(
	job: FleetJob,
): Promise<string | undefined> {
	if (!job.sandboxId || !process.env.E2B_API_KEY?.trim()) return undefined;
	try {
		const sandbox = await connectSandboxDefault(job.sandboxId);
		await sandbox.kill?.();
		return undefined;
	} catch (err) {
		return sanitizeSecrets(err instanceof Error ? err.message : String(err));
	}
}
