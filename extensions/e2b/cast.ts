import {
	findJobByIdOrSandboxId,
	newJobId,
	updateJob,
	writeJob,
} from "./jobs.js";
import { connectE2BSandbox, createE2BSandbox } from "./sdk.js";
import {
	buildRunnerScript,
	collectWorkerEnv,
	githubTokenPresent,
	resolveFleetRepoUrl,
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

export const MISSING_TEMPLATE_ERROR =
	"FLEET_E2B_TEMPLATE is required for non-dry-run implementer casts (e.g. FLEET_E2B_TEMPLATE=pi-fleet-node22)";

export const SANDBOX_VERSION_ERROR_HINT =
	"E2B sandbox creation crashed inside the SDK while reading an envd 'version'. " +
	"This usually means FLEET_E2B_TEMPLATE points to a template that is not " +
	"published to the E2B account behind E2B_API_KEY, or was built with a " +
	"mismatched @e2b/cli version. Confirm `e2b template list` shows the template " +
	"for this key and republish it with the matching CLI, then retry.";

/**
 * The e2b SDK can fail deep in its envd handshake with an opaque
 * "Cannot read properties of undefined (reading 'version')" (Node) or the
 * equivalent JSC/WebKit phrasing. On its own that message tells the project
 * lead nothing actionable, so we detect it and rewrap it with a hint.
 */
export function isOpaqueVersionError(err: unknown): boolean {
	const message = err instanceof Error ? err.message : String(err);
	// Node/V8: Cannot read properties of undefined (reading 'version')
	if (/reading '?version'?/.test(message)) return true;
	// JSC/WebKit: undefined is not an object (evaluating 'x.version')
	if (/is not an object.*\.version/.test(message)) return true;
	return false;
}

export function describeSandboxError(err: unknown): string {
	const message = err instanceof Error ? err.message : String(err);
	if (isOpaqueVersionError(err)) {
		return `${SANDBOX_VERSION_ERROR_HINT} (original SDK error: ${message})`;
	}
	return message;
}

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

/**
 * The minimal sandbox surface tryCreateSandbox drives after creation. The real
 * e2b `Sandbox` satisfies this; tests inject a fake to assert the command
 * sequence (chmod-before-write ordering, kill-on-setup-failure).
 */
export interface RunnableSandbox {
	sandboxId?: string;
	files: { write(path: string, content: string): Promise<void> };
	commands: {
		run(command: string, options?: Record<string, unknown>): Promise<unknown>;
	};
	kill(): Promise<void>;
}

export type RawSandboxFactory = (
	template: string,
	opts: { timeoutMs: number; apiKey: string },
) => Promise<RunnableSandbox>;

export interface CastDependencies {
	createSandbox?: (job: FleetJob) => Promise<SandboxStartResult>;
}

export interface RefreshDependencies {
	connectSandbox?: (sandboxId: string) => Promise<SandboxLike>;
}

export interface ReconnectDependencies extends RefreshDependencies {
	now?: () => Date;
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
	return connectE2BSandbox<SandboxLike>(sandboxId);
}

export async function tryCreateSandbox(
	job: FleetJob,
	createRawSandbox?: RawSandboxFactory,
): Promise<SandboxStartResult> {
	const apiKey = process.env.E2B_API_KEY?.trim();
	if (!apiKey) {
		throw new Error("E2B_API_KEY is not set");
	}

	const template = process.env.FLEET_E2B_TEMPLATE?.trim();
	if (!template) {
		// Sandbox.create() without a template relies on an org default template
		// that this fleet does not configure; calling it crashes deep inside the
		// SDK's envd handshake instead of failing clearly. Fail fast here.
		throw new Error(MISSING_TEMPLATE_ERROR);
	}

	// The runner clones FLEET_REPO_URL to /work/pi-fleet for its wrappers; a
	// missing value would otherwise emit `git clone ''` inside the sandbox and
	// die with "fatal: repository '' does not exist". Fail fast before we pay to
	// create a sandbox.
	resolveFleetRepoUrl();

	const timeoutMs = job.timeoutMinutes * 60 * 1000;

	// Raw SDK errors (including the opaque envd "reading 'version'" crash) are
	// translated once at the castJob funnel via describeSandboxError, so every
	// createSandbox implementation benefits — not just this default one.
	const createRaw: RawSandboxFactory =
		createRawSandbox ??
		((t, opts) => createE2BSandbox<RunnableSandbox>(t, opts));

	const sandbox = await createRaw(template, { timeoutMs, apiKey });

	// Everything from here — including the missing-sandboxId guard — runs inside
	// the cleanup-protected block: once create() resolves we may hold a live,
	// billed sandbox, so any failure (bad/missing id or a setup command) must
	// kill it before propagating, or we leak it.
	try {
		if (!sandbox?.sandboxId) {
			throw new Error(
				`E2B Sandbox.create returned no sandboxId for template "${template}"`,
			);
		}

		// /work is created by the template's build (root) but the sandbox runs
		// commands as its non-root default user; re-assert ownership/perms as
		// root *before* writing into /work so this succeeds even if the
		// template image predates the Dockerfile chown fix (i.e. /work is
		// still root-owned and the non-root user can't write into it yet).
		await sandbox.commands.run("mkdir -p /work && chmod -R a+rwX /work", {
			timeoutMs: 60_000,
			user: "root",
		});

		const runner = buildRunnerScript(job);
		await sandbox.files.write("/work/run-job.sh", runner);

		await sandbox.commands.run("chmod +x /work/run-job.sh", {
			timeoutMs: 60_000,
			user: "root",
		});

		await sandbox.commands.run(
			"bash -lc 'nohup /work/run-job.sh >/work/job.log 2>&1 & echo $! > /work/job.pid'",
			{
				timeoutMs: 60_000,
				envs: collectWorkerEnv(),
			},
		);
	} catch (err) {
		try {
			await sandbox?.kill?.();
		} catch {
			// best-effort cleanup; surface the original failure below
		}
		const message = err instanceof Error ? err.message : String(err);
		// A missing sandboxId means create() never gave us a usable sandbox, so
		// don't claim it "started"; only prefix when we actually have an id.
		const prefix = sandbox?.sandboxId
			? `sandbox ${sandbox.sandboxId} started but runner setup failed: `
			: "";
		throw new Error(`${prefix}${message}`);
	}

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

export async function reconnectSandbox(
	sandboxId: string,
	deps: ReconnectDependencies = {},
): Promise<FleetJob> {
	const id = sandboxId.trim();
	if (!id) throw new Error("sandboxId is required");
	if (!/^[A-Za-z0-9_-]+$/.test(id)) {
		throw new Error(`invalid sandboxId: ${sandboxId}`);
	}

	const existing = await findJobByIdOrSandboxId(id);
	if (existing) return refreshFromSandbox(existing, deps);

	let sandbox: SandboxLike;
	try {
		sandbox = deps.connectSandbox
			? await deps.connectSandbox(id)
			: await connectSandboxDefault(id);
	} catch (err) {
		throw new Error(
			`Could not reconnect to sandbox ${id}: ${sanitizeSecrets(err instanceof Error ? err.message : String(err))}`,
		);
	}
	const now = (deps.now ?? (() => new Date()))().toISOString();
	let remote: Partial<FleetJob> = {};
	try {
		remote = sanitizeObject(
			JSON.parse(await sandbox.files.read("/work/result.json")),
		) as Partial<FleetJob>;
	} catch {
		// A running job may not have emitted result.json yet.
	}

	let logTail = "";
	try {
		logTail = sanitizeSecrets(await sandbox.files.read("/work/job.log")).slice(
			-4000,
		);
	} catch {
		// Logs may not exist yet.
	}

	let brief = "";
	try {
		brief = sanitizeSecrets(await sandbox.files.read("/work/brief.md"));
	} catch {
		// Older/non-fleet sandboxes may not have a brief.
	}

	const resultJobId =
		typeof remote.jobId === "string" &&
		/^[A-Za-z0-9_-]+$/.test(remote.jobId.trim())
			? remote.jobId.trim()
			: undefined;
	const logJobId = logTail.match(/fleet e2b job ([A-Za-z0-9_-]+) (?:starting|finished)/)?.[1];
	const remoteJobId = resultJobId ?? logJobId ?? id;
	const remoteCreatedAt =
		typeof remote.createdAt === "string" ? remote.createdAt : now;
	const status =
		typeof remote.status === "string" &&
		["queued", "running", "succeeded", "failed", "timeout", "cancelled", "needs_input"].includes(
			remote.status,
		)
			? (remote.status as FleetJob["status"])
			: "running";
	const job: FleetJob = {
		jobId: remoteJobId,
		profile: "implementer",
		status,
		brief:
			typeof remote.brief === "string"
				? remote.brief
				: brief || `Reconnected to E2B sandbox ${id}`,
		codeAccess: ["none", "clone", "pr", "branch"].includes(
			remote.codeAccess ?? "",
		)
			? (remote.codeAccess as FleetJob["codeAccess"])
			: "none",
		repo: remote.repo,
		baseBranch: remote.baseBranch,
		prNumber: remote.prNumber,
		branch: remote.branch,
		ticketId: remote.ticketId,
		provider: remote.provider,
		model: remote.model,
		timeoutMinutes: remote.timeoutMinutes ?? DEFAULT_TIMEOUT_MINUTES,
		fleetRef: remote.fleetRef,
		dryRun: false,
		sandboxId: id,
		commitSha: remote.commitSha,
		prUrl: remote.prUrl,
		commandsRun: remote.commandsRun,
		blockers: remote.blockers,
		questions: remote.questions,
		artifacts: remote.artifacts,
		error: remote.error,
		logTail,
		createdAt: remoteCreatedAt,
		updatedAt: typeof remote.updatedAt === "string" ? remote.updatedAt : now,
		finishedAt: remote.finishedAt,
	};

	return writeJob(sanitizeObject(job) as FleetJob);
}

export async function resolveAndRefreshJob(
	id: string,
	deps: ReconnectDependencies = {},
): Promise<FleetJob> {
	const local = await findJobByIdOrSandboxId(id);
	return local ? refreshFromSandbox(local, deps) : reconnectSandbox(id, deps);
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
			const nextStatus = (remote.status as FleetJob["status"]) || job.status;
			// Lifecycle hygiene: once the remote side has written a terminal result,
			// the sandbox is done; kill it immediately rather than waiting for TTL.
			if (isTerminal(nextStatus)) {
				try {
					await sandbox.kill?.();
				} catch {
					// ignore best-effort kill
				}
			}
			return updateJob(
				job.jobId,
				sanitizeJobPatch({
					status: nextStatus,
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
		const message = sanitizeSecrets(describeSandboxError(err));
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
