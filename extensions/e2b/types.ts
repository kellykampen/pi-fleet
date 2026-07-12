export type JobStatus =
	| "queued"
	| "running"
	| "succeeded"
	| "failed"
	| "timeout"
	| "cancelled"
	| "needs_input";

export type CodeAccess = "none" | "clone" | "pr" | "branch";

export type FleetProfile = "implementer" | "reviewer";

/** Review verdict emitted by a reviewer-profile cast (FLT-45). */
export type ReviewVerdict = "APPROVE" | "REQUEST-CHANGES" | "UNKNOWN";

export interface CommandRun {
	cmd: string;
	exit: number;
	logRef?: string;
}

export interface FleetJob {
	jobId: string;
	profile: FleetProfile;
	status: JobStatus;
	ticketId?: string;
	brief: string;
	codeAccess: CodeAccess;
	repo?: string;
	baseBranch?: string;
	prNumber?: number;
	branch?: string;
	provider?: string;
	model?: string;
	timeoutMinutes: number;
	fleetRef?: string;
	dryRun: boolean;
	sandboxId?: string;
	commitSha?: string;
	prUrl?: string;
	commandsRun?: CommandRun[];
	blockers?: string[];
	questions?: string[];
	artifacts?: string[];
	error?: string;
	logTail?: string;
	createdAt: string;
	updatedAt: string;
	finishedAt?: string;
	/** Ceiling on total job lifetime regardless of keepalive extensions. */
	maxLifetimeMinutes?: number;
	/** Timestamp of the last successful keepalive sandbox-timeout extension. */
	lastExtendedAt?: string;
	/** profile=reviewer only: APPROVE / REQUEST-CHANGES / UNKNOWN. */
	verdict?: ReviewVerdict;
	/** profile=reviewer only: the reviewer's findings, as posted to the PR. */
	findingsSummary?: string;
	/** profile=reviewer only: URL of the posted PR comment/review. */
	reviewUrl?: string;
	/**
	 * profile=reviewer only: the exact read-only commands the sandbox ran
	 * (gh pr view/diff/comment), proving no code-mutating command was issued.
	 */
	readOnlyEvidence?: string[];
}

export interface CastParams {
	profile: FleetProfile;
	brief: string;
	codeAccess: CodeAccess;
	repo?: string;
	baseBranch?: string;
	prNumber?: number;
	branch?: string;
	ticketId?: string;
	provider?: string;
	model?: string;
	timeoutMinutes?: number;
	fleetRef?: string;
	dryRun?: boolean;
	maxLifetimeMinutes?: number;
}

/**
 * Filter for listing jobs. Mirrors the "status / project / ticketId" views the
 * fleet UI needs. `repo` is the "project" dimension (owner/name). Omitted fields
 * match everything; `status` may be a single status or a set.
 */
export interface JobFilter {
	status?: JobStatus | JobStatus[];
	repo?: string;
	ticketId?: string;
}

/**
 * Low-level persistence for {@link FleetJob} records. Implementations are pure
 * storage — secret sanitization and timestamp/finishedAt bookkeeping live in the
 * jobs.ts verbs, so Local and Convex stores can never drift on that logic.
 */
export interface JobStore {
	/** Upsert a job by its jobId. */
	put(job: FleetJob): Promise<void>;
	/** Fetch a job by id, or null when it does not exist. */
	get(jobId: string): Promise<FleetJob | null>;
	/** List jobs (newest first), optionally filtered by status/repo/ticketId. */
	list(filter?: JobFilter): Promise<FleetJob[]>;
}

export const DEFAULT_TIMEOUT_MINUTES = 90;
/**
 * Overall job-lifetime ceiling enforced by refreshFromSandbox, independent of
 * timeoutMinutes. Keepalive periodically re-extends the sandbox's own TTL
 * (sized at timeoutMinutes) so it survives past that window while the job is
 * still active; this ceiling still bounds runaway jobs.
 */
export const DEFAULT_MAX_LIFETIME_MINUTES = 180;
/** How often castJob's keepalive re-extends the sandbox timeout. */
export const DEFAULT_KEEPALIVE_INTERVAL_MINUTES = 20;
export const TERMINAL_STATUSES: JobStatus[] = [
	"succeeded",
	"failed",
	"timeout",
	"cancelled",
	"needs_input",
];

export function isTerminal(status: JobStatus): boolean {
	return TERMINAL_STATUSES.includes(status);
}
