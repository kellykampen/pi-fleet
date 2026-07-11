import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * Convex table for fleet E2B jobs. Every field mirrors `FleetJob` in
 * ../types.ts one-to-one, so the stored document *is* the e2b tool contract
 * (the ConvexJobStore round-trips it verbatim). Keep this in sync with types.ts.
 */
export const jobFields = {
	jobId: v.string(),
	profile: v.literal("implementer"),
	status: v.union(
		v.literal("queued"),
		v.literal("running"),
		v.literal("succeeded"),
		v.literal("failed"),
		v.literal("timeout"),
		v.literal("cancelled"),
		v.literal("needs_input"),
	),
	ticketId: v.optional(v.string()),
	brief: v.string(),
	codeAccess: v.union(
		v.literal("none"),
		v.literal("clone"),
		v.literal("pr"),
		v.literal("branch"),
	),
	repo: v.optional(v.string()),
	baseBranch: v.optional(v.string()),
	prNumber: v.optional(v.number()),
	branch: v.optional(v.string()),
	provider: v.optional(v.string()),
	model: v.optional(v.string()),
	timeoutMinutes: v.number(),
	fleetRef: v.optional(v.string()),
	dryRun: v.boolean(),
	sandboxId: v.optional(v.string()),
	commitSha: v.optional(v.string()),
	prUrl: v.optional(v.string()),
	commandsRun: v.optional(
		v.array(
			v.object({
				cmd: v.string(),
				exit: v.number(),
				logRef: v.optional(v.string()),
			}),
		),
	),
	blockers: v.optional(v.array(v.string())),
	questions: v.optional(v.array(v.string())),
	artifacts: v.optional(v.array(v.string())),
	error: v.optional(v.string()),
	logTail: v.optional(v.string()),
	createdAt: v.string(),
	updatedAt: v.string(),
	finishedAt: v.optional(v.string()),
};

export default defineSchema({
	jobs: defineTable(jobFields)
		.index("by_jobId", ["jobId"])
		.index("by_status", ["status"])
		.index("by_repo", ["repo"])
		.index("by_ticket", ["ticketId"]),
});
