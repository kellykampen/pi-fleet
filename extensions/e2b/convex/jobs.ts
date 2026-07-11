import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { jobFields } from "./schema";

/**
 * Server functions backing ConvexJobStore (../convexStore.ts). Called over the
 * Convex HTTP API as `jobs:put` / `jobs:get` / `jobs:list`.
 */

/** A stored job document = the FleetJob fields plus Convex system fields. */
const jobDoc = v.object({
	_id: v.id("jobs"),
	_creationTime: v.number(),
	...jobFields,
});

/** Safety cap so `list` never loads an unbounded table into memory. */
const MAX_JOBS = 1000;

const statusArg = v.union(
	v.literal("queued"),
	v.literal("running"),
	v.literal("succeeded"),
	v.literal("failed"),
	v.literal("timeout"),
	v.literal("cancelled"),
	v.literal("needs_input"),
);

/** Upsert a job by jobId (jobId is the stable app-level key, not the _id). */
export const put = mutation({
	args: { job: v.object(jobFields) },
	returns: v.null(),
	handler: async (ctx, { job }) => {
		const existing = await ctx.db
			.query("jobs")
			.withIndex("by_jobId", (q) => q.eq("jobId", job.jobId))
			.unique();
		if (existing) {
			await ctx.db.replace(existing._id, job);
		} else {
			await ctx.db.insert("jobs", job);
		}
		return null;
	},
});

export const get = query({
	args: { jobId: v.string() },
	returns: v.union(jobDoc, v.null()),
	handler: async (ctx, { jobId }) => {
		return await ctx.db
			.query("jobs")
			.withIndex("by_jobId", (q) => q.eq("jobId", jobId))
			.unique();
	},
});

export const list = query({
	args: {
		status: v.optional(v.union(statusArg, v.array(statusArg))),
		repo: v.optional(v.string()),
		ticketId: v.optional(v.string()),
	},
	returns: v.array(jobDoc),
	handler: async (ctx, { status, repo, ticketId }) => {
		// Pick the most selective index available, then filter the rest in JS.
		// Every path is bounded by MAX_JOBS.
		let rows;
		if (repo !== undefined) {
			rows = await ctx.db
				.query("jobs")
				.withIndex("by_repo", (q) => q.eq("repo", repo))
				.take(MAX_JOBS);
		} else if (ticketId !== undefined) {
			rows = await ctx.db
				.query("jobs")
				.withIndex("by_ticket", (q) => q.eq("ticketId", ticketId))
				.take(MAX_JOBS);
		} else {
			rows = await ctx.db.query("jobs").take(MAX_JOBS);
		}

		const wanted =
			status === undefined
				? null
				: Array.isArray(status)
					? status
					: [status];

		return rows.filter((job) => {
			if (ticketId !== undefined && job.ticketId !== ticketId) return false;
			if (wanted && !wanted.includes(job.status)) return false;
			return true;
		});
	},
});
