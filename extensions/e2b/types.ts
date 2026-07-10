export type JobStatus =
	| "queued"
	| "running"
	| "succeeded"
	| "failed"
	| "timeout"
	| "cancelled"
	| "needs_input";

export type CodeAccess = "none" | "clone" | "pr" | "branch";

export type FleetProfile = "implementer";

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
}

export const DEFAULT_TIMEOUT_MINUTES = 90;
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
