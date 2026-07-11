import { readJob } from "./jobs.js";
import { connectE2BSandbox } from "./sdk.js";
import { sanitizeSecrets } from "./secrets.js";
import { isTerminal } from "./types.js";

interface SandboxHostLike {
	getHost(port: number): string;
	isRunning(): Promise<boolean>;
}

export interface PortProbeResult {
	ok: boolean;
	status?: number;
	error?: string;
}

export interface PortUrlDependencies {
	connectSandbox?: (sandboxId: string) => Promise<SandboxHostLike>;
	probe?: (url: string) => Promise<PortProbeResult>;
}

export interface PortUrlParams {
	jobId?: string;
	sandboxId?: string;
	port: number;
}

export interface PortUrlResult {
	url: string;
	sandboxId: string;
	port: number;
}

async function connectSandboxDefault(
	sandboxId: string,
): Promise<SandboxHostLike> {
	return connectE2BSandbox<SandboxHostLike>(sandboxId);
}

/**
 * The E2B edge proxy returns 502/503 for a port with no listener rather than
 * failing the connection outright, so a plain "did the request succeed" check
 * would call a closed port "open". Treat those statuses as the port being closed.
 */
async function defaultProbe(url: string): Promise<PortProbeResult> {
	try {
		const res = await fetch(url, {
			method: "HEAD",
			signal: AbortSignal.timeout(10_000),
		});
		if (res.status === 502 || res.status === 503) {
			return {
				ok: false,
				status: res.status,
				error: `sandbox proxy returned ${res.status} (no service listening on this port)`,
			};
		}
		return { ok: true, status: res.status };
	} catch (err) {
		return {
			ok: false,
			error: err instanceof Error ? err.message : String(err),
		};
	}
}

async function resolveSandboxId(params: PortUrlParams): Promise<string> {
	if (params.sandboxId?.trim()) return params.sandboxId.trim();
	if (!params.jobId?.trim()) {
		throw new Error("either jobId or sandboxId is required");
	}
	const job = await readJob(params.jobId);
	if (job.dryRun || !job.sandboxId) {
		throw new Error(
			`job ${job.jobId} has no live sandbox (dryRun=${job.dryRun}, status=${job.status})`,
		);
	}
	if (isTerminal(job.status)) {
		throw new Error(
			`job ${job.jobId} sandbox is not running (status: ${job.status})`,
		);
	}
	return job.sandboxId;
}

export async function resolvePortUrl(
	params: PortUrlParams,
	deps: PortUrlDependencies = {},
): Promise<PortUrlResult> {
	if (!Number.isInteger(params.port) || params.port <= 0 || params.port > 65535) {
		throw new Error(`invalid port: ${params.port}`);
	}

	const sandboxId = await resolveSandboxId(params);

	let sandbox: SandboxHostLike;
	try {
		sandbox = deps.connectSandbox
			? await deps.connectSandbox(sandboxId)
			: await connectSandboxDefault(sandboxId);
	} catch (err) {
		throw new Error(
			`sandbox ${sandboxId} is not running or unreachable: ${sanitizeSecrets(err instanceof Error ? err.message : String(err))}`,
		);
	}

	const running = await sandbox.isRunning();
	if (!running) {
		throw new Error(`sandbox ${sandboxId} is not running`);
	}

	let host: string;
	try {
		host = sandbox.getHost(params.port);
	} catch (err) {
		throw new Error(
			`could not resolve a URL for port ${params.port} on sandbox ${sandboxId}: ${sanitizeSecrets(err instanceof Error ? err.message : String(err))}`,
		);
	}
	const url = host.startsWith("http") ? host : `https://${host}`;

	const probe = deps.probe ?? defaultProbe;
	const result = await probe(url);
	if (!result.ok) {
		throw new Error(
			`port ${params.port} on sandbox ${sandboxId} is not open: ${result.error ?? `probe returned status ${result.status}`}`,
		);
	}

	return { url, sandboxId, port: params.port };
}
