import type { FleetJob, JobFilter, JobStore } from "./types.js";

/**
 * Convex-backed {@link JobStore}. Talks to a Convex deployment over its public
 * HTTP API (`/api/query`, `/api/mutation`) so this client needs no `convex` npm
 * dependency and stays trivially mockable — tests inject `fetchImpl`.
 *
 * The matching server functions (`jobs:put` / `jobs:get` / `jobs:list`) and the
 * table schema live under `convex/` in this extension; see docs/e2b-convex.md.
 *
 * Configuration (env, with local `~/.pi/fleet/jobs` as fallback when unset):
 *   FLEET_CONVEX_URL   deployment URL, e.g. https://acme-123.convex.cloud
 *   FLEET_CONVEX_TOKEN optional bearer token for authed deployments
 */

type FetchLike = (
	url: string,
	init: {
		method: string;
		headers: Record<string, string>;
		body: string;
	},
) => Promise<{
	ok: boolean;
	status: number;
	json(): Promise<unknown>;
	text?(): Promise<string>;
}>;

export interface ConvexJobStoreOptions {
	url?: string;
	token?: string;
	fetchImpl?: FetchLike;
}

/** Convex adds `_id`/`_creationTime` to every document; strip them from jobs. */
function stripSystemFields(row: Record<string, unknown>): FleetJob {
	const { _id, _creationTime, ...job } = row;
	return job as unknown as FleetJob;
}

export function isConvexConfigured(): boolean {
	return Boolean(process.env.FLEET_CONVEX_URL?.trim());
}

export class ConvexJobStore implements JobStore {
	private readonly url: string;
	private readonly token?: string;
	private readonly fetchImpl: FetchLike;

	constructor(options: ConvexJobStoreOptions = {}) {
		const url = (options.url ?? process.env.FLEET_CONVEX_URL ?? "").trim();
		if (!url) {
			throw new Error(
				"ConvexJobStore requires a deployment URL (FLEET_CONVEX_URL).",
			);
		}
		this.url = url.replace(/\/+$/, "");
		this.token = options.token ?? process.env.FLEET_CONVEX_TOKEN?.trim();
		this.fetchImpl = options.fetchImpl ?? (globalThis.fetch as FetchLike);
	}

	private async call(
		kind: "query" | "mutation",
		path: string,
		args: Record<string, unknown>,
	): Promise<unknown> {
		const headers: Record<string, string> = {
			"Content-Type": "application/json",
		};
		if (this.token) headers.Authorization = `Bearer ${this.token}`;

		const res = await this.fetchImpl(`${this.url}/api/${kind}`, {
			method: "POST",
			headers,
			body: JSON.stringify({ path, args, format: "json" }),
		});

		if (!res.ok) {
			const detail = res.text ? await res.text() : "";
			throw new Error(
				`Convex ${kind} ${path} failed: HTTP ${res.status}${
					detail ? ` — ${detail}` : ""
				}`,
			);
		}

		const payload = (await res.json()) as {
			status?: string;
			value?: unknown;
			errorMessage?: string;
		};
		if (payload.status === "error") {
			throw new Error(
				`Convex ${kind} ${path} error: ${payload.errorMessage ?? "unknown"}`,
			);
		}
		return payload.value;
	}

	async put(job: FleetJob): Promise<void> {
		await this.call("mutation", "jobs:put", { job });
	}

	async get(jobId: string): Promise<FleetJob | null> {
		const value = await this.call("query", "jobs:get", { jobId });
		if (!value) return null;
		return stripSystemFields(value as Record<string, unknown>);
	}

	async list(filter?: JobFilter): Promise<FleetJob[]> {
		const args: Record<string, unknown> = {};
		if (filter?.status !== undefined) args.status = filter.status;
		if (filter?.repo !== undefined) args.repo = filter.repo;
		if (filter?.ticketId !== undefined) args.ticketId = filter.ticketId;

		const value = (await this.call("query", "jobs:list", args)) as
			| Record<string, unknown>[]
			| null;
		const rows = Array.isArray(value) ? value : [];
		return rows
			.map((row) => stripSystemFields(row))
			.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
	}
}
