import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path, { join } from "node:path";

import { REPO_SOURCE_ARCHIVE_PATH } from "./archive.ts";
import {
	GITHUB_APP_ID_ENV,
	GITHUB_APP_INSTALLATION_ID_ENV,
	GITHUB_APP_PRIVATE_KEY_ENV,
} from "./githubApp.ts";
import {
	buildResultFinalizer,
	buildReviewerResultFinalizer,
	buildReviewerRunnerScript,
	buildRunnerScript,
	collectWorkerEnv,
	FLEET_WORKER_MODEL_KEYS,
	githubCredentialSourceConfigured,
	githubReviewerTokenPresent,
	MISSING_FLEET_REPO_URL_ERROR,
	normalizeRepoSlug,
	PI_AGENT_AUTH_ENV,
	resolveFleetRepoUrl,
	resolveGithubReviewerToken,
	resolveInjectedGithubToken,
	sanitizeSecrets,
	TARGET_REPO_ACCESS_ERROR_HINT,
} from "./secrets.ts";
import {
	castJob,
	describeSandboxError,
	isOpaqueVersionError,
	MISSING_TEMPLATE_ERROR,
	refreshFromSandbox,
	type RunnableSandbox,
	SANDBOX_VERSION_ERROR_HINT,
	tryCreateSandbox,
} from "./cast.ts";
import { readJob, writeJob } from "./jobs.ts";
import type { FleetJob } from "./types.ts";

const ORIGINAL_ENV = { ...process.env };

function clearSensitiveEnv() {
	delete process.env.FLEET_GITHUB_TOKEN;
	delete process.env.FLEET_GITHUB_REVIEWER_TOKEN;
	delete process.env.GH_TOKEN;
	delete process.env.E2B_API_KEY;
	delete process.env.FLEET_REPO_URL;
	delete process.env.FLEET_E2B_TEMPLATE;
	delete process.env[PI_AGENT_AUTH_ENV];
	delete process.env[GITHUB_APP_ID_ENV];
	delete process.env[GITHUB_APP_INSTALLATION_ID_ENV];
	delete process.env[GITHUB_APP_PRIVATE_KEY_ENV];
	for (const key of FLEET_WORKER_MODEL_KEYS) delete process.env[key];
}

function restoreEnv() {
	for (const key of Object.keys(process.env)) {
		if (!(key in ORIGINAL_ENV)) delete process.env[key];
	}
	Object.assign(process.env, ORIGINAL_ENV);
}

test.beforeEach(() => {
	clearSensitiveEnv();
});

test.afterEach(() => {
	restoreEnv();
});

test("collectWorkerEnv forwards GitHub and fleet worker keys under canonical names", () => {
	process.env.GH_TOKEN = "ghp_abcdefghijklmnopqrstuvwxyz1234567890";
	process.env.OPENAI_API_KEY = "sk-worker-openai";
	process.env.ANTHROPIC_API_KEY = "sk-worker-anthropic";

	assert.deepEqual(collectWorkerEnv(), {
		FLEET_GITHUB_TOKEN: "ghp_abcdefghijklmnopqrstuvwxyz1234567890",
		OPENAI_API_KEY: "sk-worker-openai",
		ANTHROPIC_API_KEY: "sk-worker-anthropic",
	});
});

test("collectWorkerEnv forwards the pi agent auth blob when present", () => {
	process.env[PI_AGENT_AUTH_ENV] = "eyJvYXV0aCI6ICJ0b2tlbi1zZWNyZXQifQ==";

	assert.equal(
		collectWorkerEnv()[PI_AGENT_AUTH_ENV],
		"eyJvYXV0aCI6ICJ0b2tlbi1zZWNyZXQifQ==",
	);
	// Absent when unset (no empty string leaked into the sandbox env).
	delete process.env[PI_AGENT_AUTH_ENV];
	assert.equal(PI_AGENT_AUTH_ENV in collectWorkerEnv(), false);
});

// Throwaway RSA keypair generated fresh in-process — never a real App secret.
function generateTestRsaPrivateKey(): string {
	return generateKeyPairSync("rsa", {
		modulusLength: 2048,
		publicKeyEncoding: { type: "spki", format: "pem" },
		privateKeyEncoding: { type: "pkcs1", format: "pem" },
	}).privateKey;
}

function implementerJob(overrides: Partial<FleetJob> = {}): FleetJob {
	const now = new Date().toISOString();
	return {
		jobId: "job-12345678",
		profile: "implementer",
		status: "queued",
		brief: "do the thing",
		codeAccess: "clone",
		repo: "owner/repo",
		timeoutMinutes: 90,
		dryRun: false,
		createdAt: now,
		updatedAt: now,
		...overrides,
	};
}

test("buildRunnerScript never embeds token values", () => {
	process.env.FLEET_REPO_URL = "https://github.com/owner/pi-fleet.git";
	process.env.FLEET_GITHUB_TOKEN =
		"github_pat_thisSecretMustNotAppearInTheRunnerScript123456";
	process.env.OPENAI_API_KEY = "sk-worker-secret";
	const script = buildRunnerScript(implementerJob());

	assert.equal(script.includes(process.env.FLEET_GITHUB_TOKEN), false);
	assert.equal(script.includes(process.env.OPENAI_API_KEY), false);
	assert.match(script, /FLEET_GITHUB_TOKEN/);
});

test("resolveFleetRepoUrl throws a clear error when FLEET_REPO_URL is unset", () => {
	delete process.env.FLEET_REPO_URL;
	assert.throws(() => resolveFleetRepoUrl(), /FLEET_REPO_URL is required/);
	process.env.FLEET_REPO_URL = "  https://github.com/owner/pi-fleet.git  ";
	assert.equal(resolveFleetRepoUrl(), "https://github.com/owner/pi-fleet.git");
});

test("buildRunnerScript fails fast instead of emitting `git clone ''` when FLEET_REPO_URL is unset", () => {
	delete process.env.FLEET_REPO_URL;
	assert.throws(
		() => buildRunnerScript(implementerJob()),
		new RegExp(MISSING_FLEET_REPO_URL_ERROR.slice(0, 24)),
	);
});

test("buildRunnerScript anchors Outfitter profile resolution to /work/pi-fleet/profiles", () => {
	process.env.FLEET_REPO_URL = "https://github.com/owner/pi-fleet.git";
	const script = buildRunnerScript(implementerJob());

	// The clone of the pi-fleet pin must use a real URL, never an empty string.
	assert.equal(script.includes("git clone ''"), false);
	assert.match(script, /github\.com\/owner\/pi-fleet\.git/);

	// Profiles are resolved via a user-scope settings file with an absolute path,
	// so `pi-implementer` resolves the profile even when run from /work/repo.
	assert.match(script, /\$HOME\/\.outfitter\/settings\.yml/);
	assert.match(script, /profile_sources:/);
	assert.match(script, /- path: \/work\/pi-fleet\/profiles/);

	// profile.yml extensions (`../extensions/<x>`) are resolved by pi against its
	// cwd (/work/repo) → /work/extensions/..., so the pi-fleet extensions/skills
	// must be symlinked there or the profile fails to load its extension.
	assert.match(script, /ln -sfn \/work\/pi-fleet\/extensions \/work\/extensions/);
	assert.match(script, /ln -sfn \/work\/pi-fleet\/skills \/work\/skills/);
});

test("buildRunnerScript materializes ~/.pi/agent/auth.json from the env var without embedding the token", () => {
	process.env.FLEET_REPO_URL = "https://github.com/owner/pi-fleet.git";
	// A stand-in for the base64 auth blob; the literal must never appear in the
	// generated script — only the env-var reference does.
	process.env[PI_AGENT_AUTH_ENV] = "TOKEN_LITERAL_MUST_NOT_APPEAR_zzz999";
	const script = buildRunnerScript(implementerJob());

	assert.equal(script.includes(process.env[PI_AGENT_AUTH_ENV] as string), false);
	// Decodes straight to a 600-locked file, never to stdout.
	assert.match(script, /mkdir -p "\$HOME\/\.pi\/agent"/);
	assert.match(
		script,
		/printf '%s' "\$\{PI_AGENT_AUTH_JSON_B64\}" \| base64 -d > "\$HOME\/\.pi\/agent\/auth\.json"/,
	);
	assert.match(script, /chmod 600 "\$HOME\/\.pi\/agent\/auth\.json"/);
	// Guarded so an unset blob doesn't clobber auth.json with an empty file.
	assert.match(script, /if \[ -n "\$\{PI_AGENT_AUTH_JSON_B64:-\}" \]/);
});

test("sanitizeSecrets redacts the pi agent auth blob value", () => {
	process.env[PI_AGENT_AUTH_ENV] = "eyJvYXV0aCI6ICJzdXBlci1zZWNyZXQtdG9rZW4ifQ==";

	const sanitized = sanitizeSecrets(
		`auth=${process.env[PI_AGENT_AUTH_ENV]} done`,
	);

	assert.equal(sanitized.includes(process.env[PI_AGENT_AUTH_ENV] as string), false);
	assert.equal(sanitized, "auth=*** done");
});

test("normalizeRepoSlug reduces every supported input shape to owner/repo", () => {
	const inputs = [
		"owner/repo",
		"owner/repo.git",
		"github.com/owner/repo",
		"github.com/owner/repo.git",
		"https://github.com/owner/repo",
		"https://github.com/owner/repo.git",
		"git@github.com:owner/repo.git",
		"git@github.com:owner/repo",
		"github.com/owner/repo/",
	];
	for (const input of inputs) {
		assert.equal(normalizeRepoSlug(input), "owner/repo", `input: ${input}`);
	}
});

test("normalizeRepoSlug throws a clear error on invalid input", () => {
	assert.throws(() => normalizeRepoSlug(""), /repo/i);
	assert.throws(() => normalizeRepoSlug("not-a-valid-repo"), /repo/i);
	assert.throws(() => normalizeRepoSlug("github.com/owner"), /repo/i);
	assert.throws(
		() => normalizeRepoSlug("https://github.com/owner/repo/extra"),
		/repo/i,
	);
});

test("buildRunnerScript uses the normalized per-cast repo for every target clone", () => {
	// buildRunnerScript now requires FLEET_REPO_URL (pi-fleet pin clone); set it
	// so this repo-slug normalization test exercises the checkout lines.
	process.env.FLEET_REPO_URL = "https://github.com/owner/pi-fleet.git";
	const baseJob = {
		jobId: "job-normalize",
		profile: "implementer" as const,
		status: "queued" as const,
		brief: "do the thing",
		timeoutMinutes: 90,
		dryRun: false,
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
	};

	const cloneScript = buildRunnerScript({
		...baseJob,
		codeAccess: "clone",
		repo: "github.com/kellykampen/pi-fleet.git",
	});
	assert.match(cloneScript, /export TARGET_REPO='kellykampen\/pi-fleet'/);
	// FLT-9: codeAccess=clone unpacks a pre-uploaded source archive instead of
	// having the sandbox `gh repo clone` the target — no read credentials needed
	// for this step. clone_target (the credential-bearing helper) is defined
	// (shared with pr/branch below) but never invoked for clone; extract_source_
	// archive runs instead, and the git remote is still added (using the
	// normalized slug) so the later push/PR step has somewhere to push to.
	assert.doesNotMatch(cloneScript, /^clone_target(\s|$)/m);
	assert.match(cloneScript, /^extract_source_archive$/m);
	assert.match(
		cloneScript,
		/git remote add origin 'https:\/\/github\.com\/kellykampen\/pi-fleet\.git'/,
	);

	const prScript = buildRunnerScript({
		...baseJob,
		codeAccess: "pr",
		repo: "github.com/kellykampen/pi-fleet.git",
		prNumber: 42,
	});
	assert.match(prScript, /export TARGET_REPO='kellykampen\/pi-fleet'/);
	assert.match(prScript, /clone_target\s*$/m);
	assert.equal(prScript.includes("clone_target --depth"), false);
	assert.equal(prScript.includes("github.com/kellykampen/pi-fleet.git"), false);

	const branchScript = buildRunnerScript({
		...baseJob,
		codeAccess: "branch",
		repo: "github.com/kellykampen/pi-fleet.git",
		branch: "feature/x",
	});
	assert.match(branchScript, /export TARGET_REPO='kellykampen\/pi-fleet'/);
	assert.match(branchScript, /clone_target\s*$/m);
	assert.equal(branchScript.includes("clone_target --depth"), false);
	assert.equal(branchScript.includes("github.com/kellykampen/pi-fleet.git"), false);
});

test("buildRunnerScript keeps the per-cast target separate from FLEET_REPO_URL", () => {
	process.env.FLEET_REPO_URL = "https://github.com/fleet-org/pi-fleet.git";
	const script = buildRunnerScript(
		implementerJob({ repo: "customer-org/private-app", baseBranch: "develop" }),
	);

	assert.match(
		script,
		/git clone --depth 1 --branch 'develop' 'https:\/\/github\.com\/fleet-org\/pi-fleet\.git' \/work\/pi-fleet/,
	);
	assert.match(script, /export TARGET_REPO='customer-org\/private-app'/);
	// codeAccess=clone no longer calls clone_target (that requires the sandbox
	// to hold read credentials); it extracts the pre-uploaded source archive
	// and wires the target as the push remote instead.
	assert.doesNotMatch(script, /^clone_target(\s|$)/m);
	assert.match(
		script,
		/git remote add origin 'https:\/\/github\.com\/customer-org\/private-app\.git'/,
	);
	assert.doesNotMatch(script, /TARGET_REPO='fleet-org\/pi-fleet'/);
});

test("buildRunnerScript uses full clone + gh pr checkout for codeAccess=pr", () => {
	process.env.FLEET_REPO_URL = "https://github.com/owner/pi-fleet.git";
	const script = buildRunnerScript(
		implementerJob({ codeAccess: "pr", prNumber: 42 }),
	);
	assert.match(script, /clone_target\s*$/m);
	assert.doesNotMatch(script, /clone_target --depth/);
	assert.match(script, /gh pr checkout 42/);
});

test("buildRunnerScript fetches and checks out the branch for codeAccess=branch", () => {
	process.env.FLEET_REPO_URL = "https://github.com/owner/pi-fleet.git";
	const script = buildRunnerScript(
		implementerJob({ codeAccess: "branch", branch: "feature/x" }),
	);
	assert.match(script, /clone_target\s*$/m);
	assert.doesNotMatch(script, /clone_target --depth/);
	assert.match(script, /export BRANCH_NAME='feature\/x'/);
	assert.match(script, /^checkout_branch$/m);
	assert.match(script, /git fetch origin "\$BRANCH_NAME"/);
	assert.match(script, /git checkout -b "\$BRANCH_NAME" "origin\/\$BRANCH_NAME"/);
});

test("buildRunnerScript wraps codeAccess=branch checkout so a bad branch fails fast instead of falling through to pi-implementer", () => {
	process.env.FLEET_REPO_URL = "https://github.com/owner/pi-fleet.git";
	const script = buildRunnerScript(
		implementerJob({ codeAccess: "branch", branch: "feature/does-not-exist" }),
	);

	// The fetch/checkout is wrapped the same way clone_target already handles a
	// bad target repo: on failure, mark it, finalize a terminal result, and exit
	// immediately — never fall through to running pi-implementer, which is what
	// left the job hanging until the sandbox's own timeout.
	assert.match(script, /checkout_branch\(\)\s*\{[\s\S]*?BRANCH_CHECKOUT_FAILED=1[\s\S]*?finalize_result[\s\S]*?exit "\$EXIT"[\s\S]*?\}/);
	assert.match(script, /^checkout_branch$/m);

	const checkoutFnIdx = script.indexOf("checkout_branch() {");
	const implementerIdx = script.indexOf('"$PI_IMPL"');
	assert.ok(checkoutFnIdx !== -1 && checkoutFnIdx < implementerIdx);
});

test("buildRunnerScript extracts the pre-uploaded source archive for codeAccess=clone instead of cloning with credentials (FLT-9)", () => {
	process.env.FLEET_REPO_URL = "https://github.com/owner/pi-fleet.git";
	const script = buildRunnerScript(
		implementerJob({ codeAccess: "clone", repo: "owner/private-app", branch: "fleet/my-branch" }),
	);

	// No read path requires the sandbox to hold credentials: clone_target (the
	// only place `gh repo clone` runs) is defined for the pr/branch paths but
	// never invoked here.
	assert.doesNotMatch(script, /^clone_target(\s|$)/m);

	// The runner decodes+extracts the archive the host already uploaded to
	// REPO_SOURCE_ARCHIVE_PATH, and cleans it up immediately after. `< file`
	// (stdin redirection, not a positional `base64 -d file` argument) so this
	// decodes identically under GNU and BSD base64.
	assert.match(script, /extract_source_archive\(\)\s*\{/);
	assert.match(script, /^extract_source_archive$/m);
	const escapedPath = REPO_SOURCE_ARCHIVE_PATH.replace(/\//g, "\\/");
	assert.match(
		script,
		new RegExp(`base64 -d < ${escapedPath} \\| tar -xzf - -C /work/repo`),
	);
	assert.match(script, new RegExp(`rm -f ${escapedPath}`));

	// A fresh git repo is initialized from the extracted tree, wired to the
	// target as its push remote, and the new branch is created from there —
	// so push/PR (still using FLEET_GITHUB_TOKEN) works exactly as before.
	assert.match(script, /git init -q/);
	assert.match(
		script,
		/git remote add origin 'https:\/\/github\.com\/owner\/private-app\.git'/,
	);
	assert.match(script, /git checkout -b 'fleet\/my-branch'/);

	// Extraction failure is a distinct, sanitized error — not the GH-token
	// access hint, since it has nothing to do with token scope.
	assert.match(
		script,
		/extract_source_archive\(\)\s*\{[\s\S]*?SOURCE_ARCHIVE_EXTRACT_FAILED=1[\s\S]*?finalize_result[\s\S]*?exit "\$EXIT"[\s\S]*?\}/,
	);

	const extractFnIdx = script.indexOf("extract_source_archive() {");
	const implementerIdx = script.indexOf('"$PI_IMPL"');
	assert.ok(extractFnIdx !== -1 && extractFnIdx < implementerIdx);
});

test("buildResultFinalizer surfaces a clear, sanitized error for a failed source-archive extraction, distinct from the token-access hint (FLT-9)", async () => {
	const work = await mkdtemp(join(tmpdir(), "pi-fleet-work-"));
	try {
		runFinalizer(work, {
			JOB_ID: "job-archive-extract-failed",
			EXIT: "1",
			TARGET_REPO: "owner/private-app",
			SOURCE_ARCHIVE_EXTRACT_FAILED: "1",
		});

		const result = JSON.parse(await readFile(join(work, "result.json"), "utf8"));
		assert.equal(result.status, "failed");
		assert.match(result.error, /owner\/private-app/);
		assert.equal(result.error.includes(TARGET_REPO_ACCESS_ERROR_HINT), false);
		assert.doesNotMatch(result.error, /token/i);
	} finally {
		await rm(work, { recursive: true, force: true });
	}
});

/**
 * Run the finalizer bash snippet in isolation against a throwaway $WORK dir,
 * exercising the real marker-file → result.json translation that the remote
 * runner performs after pi-implementer exits.
 */
function runFinalizer(work: string, env: Record<string, string>): void {
	const finalizer = buildResultFinalizer();
	execFileSync("bash", ["-c", `set -euo pipefail\n${finalizer}`], {
		env: { ...process.env, WORK: work, ...env },
		stdio: "pipe",
	});
}

/** Reviewer counterpart of runFinalizer — exercises buildReviewerResultFinalizer. */
function runReviewerFinalizer(work: string, env: Record<string, string>): void {
	const finalizer = buildReviewerResultFinalizer();
	execFileSync("bash", ["-c", `set -euo pipefail\n${finalizer}`], {
		env: { ...process.env, WORK: work, ...env },
		stdio: "pipe",
	});
}

test("buildResultFinalizer writes needs_input result.json when the needs-input marker is present", async () => {
	const work = await mkdtemp(join(tmpdir(), "pi-fleet-work-"));
	try {
		await writeFile(
			join(work, "needs-input.json"),
			JSON.stringify({
				questions: [
					"Which auth provider should the login flow use?",
					"What Node version does the target runtime pin?",
				],
			}),
		);

		// EXIT=0 but the marker is present: needs_input must win over the exit
		// code so ambiguous work never masquerades as a clean success.
		runFinalizer(work, {
			JOB_ID: "job-needs-input",
			EXIT: "0",
			SHA: "abc1234",
			BRANCH: "fleet/needs-input",
		});

		const result = JSON.parse(await readFile(join(work, "result.json"), "utf8"));
		assert.equal(result.status, "needs_input");
		assert.deepEqual(result.questions, [
			"Which auth provider should the login flow use?",
			"What Node version does the target runtime pin?",
		]);
		assert.equal(result.jobId, "job-needs-input");
		assert.equal(result.profile, "implementer");
		// Partial work that landed before the block is still reported.
		assert.equal(result.commitSha, "abc1234");
		assert.equal(result.branch, "fleet/needs-input");
		assert.equal(result.error, null);
	} finally {
		await rm(work, { recursive: true, force: true });
	}
});

test("buildResultFinalizer leaves an existing result.json untouched when a needs-input marker is also present", async () => {
	const work = await mkdtemp(join(tmpdir(), "pi-fleet-work-"));
	try {
		// pi-implementer's own result.json (e.g. it succeeded, then a stray or
		// stale needs-input.json is also on disk). This is the top-precedence
		// tier: an implementer-authored result.json must never be clobbered.
		const ownResult = {
			jobId: "job-precedence",
			profile: "implementer",
			status: "succeeded",
			commitSha: "deadbeef",
			prUrl: "https://github.com/owner/repo/pull/1",
			branch: "fleet/precedence",
			questions: null,
			error: null,
			finishedAt: "2026-01-01T00:00:00.000000Z",
		};
		await writeFile(
			join(work, "result.json"),
			JSON.stringify(ownResult, null, 2) + "\n",
		);
		await writeFile(
			join(work, "needs-input.json"),
			JSON.stringify({ questions: ["Should this ever surface?"] }),
		);

		const finalizer = buildResultFinalizer();
		const output = execFileSync(
			"bash",
			["-c", `set -euo pipefail\n${finalizer}\necho "FINAL_STATUS=$STATUS"`],
			{
				env: {
					...process.env,
					WORK: work,
					JOB_ID: "job-precedence",
					EXIT: "0",
				},
				stdio: "pipe",
			},
		).toString();

		const result = JSON.parse(await readFile(join(work, "result.json"), "utf8"));
		assert.deepEqual(result, ownResult);

		// The log line must reflect the persisted (succeeded) result, not the
		// needs_input the marker file alone would imply.
		assert.match(output, /FINAL_STATUS=succeeded/);
	} finally {
		await rm(work, { recursive: true, force: true });
	}
});

test("buildResultFinalizer surfaces a clear sanitized target-repo access error", async () => {
	const work = await mkdtemp(join(tmpdir(), "pi-fleet-work-"));
	try {
		const token = "github_pat_cloneFailureSecret_abcdefghijklmnopqrstuvwxyz123456";
		process.env.FLEET_GITHUB_TOKEN = token;
		runFinalizer(work, {
			JOB_ID: "job-clone-denied",
			EXIT: "1",
			TARGET_REPO: "customer-org/private-app",
			TARGET_REPO_CLONE_FAILED: "1",
		});

		const raw = await readFile(join(work, "result.json"), "utf8");
		const result = JSON.parse(raw);
		assert.equal(result.status, "failed");
		assert.equal(
			result.error,
			`Target repository clone failed for customer-org/private-app: ${TARGET_REPO_ACCESS_ERROR_HINT}`,
		);
		assert.match(result.error, /token has repository access/i);
		assert.equal(raw.includes(token), false);
	} finally {
		await rm(work, { recursive: true, force: true });
	}
});

test("buildResultFinalizer surfaces a clear error for a bad/nonexistent branch instead of masquerading as running", async () => {
	const work = await mkdtemp(join(tmpdir(), "pi-fleet-work-"));
	try {
		runFinalizer(work, {
			JOB_ID: "job-bad-branch",
			EXIT: "1",
			TARGET_REPO: "owner/repo",
			BRANCH_CHECKOUT_FAILED: "1",
			BRANCH_NAME: "feature/does-not-exist",
		});

		const result = JSON.parse(await readFile(join(work, "result.json"), "utf8"));
		assert.equal(result.status, "failed");
		assert.match(result.error, /feature\/does-not-exist/);
		assert.match(result.error, /owner\/repo/);
	} finally {
		await rm(work, { recursive: true, force: true });
	}
});

test("buildResultFinalizer falls through to succeeded/failed by exit code when no marker exists", async () => {
	const work = await mkdtemp(join(tmpdir(), "pi-fleet-work-"));
	try {
		runFinalizer(work, { JOB_ID: "job-ok", EXIT: "0" });
		const ok = JSON.parse(await readFile(join(work, "result.json"), "utf8"));
		assert.equal(ok.status, "succeeded");
		assert.equal(ok.questions, null);
		assert.equal(ok.error, null);

		await rm(join(work, "result.json"));

		runFinalizer(work, { JOB_ID: "job-bad", EXIT: "2" });
		const bad = JSON.parse(await readFile(join(work, "result.json"), "utf8"));
		assert.equal(bad.status, "failed");
		assert.equal(bad.questions, null);
		assert.match(bad.error ?? "", /exited 2/);
	} finally {
		await rm(work, { recursive: true, force: true });
	}
});

test("refreshFromSandbox persists needs_input status and questions from a remote result.json", async () => {
	const jobsDir = await mkdtemp(join(tmpdir(), "pi-fleet-jobs-"));
	process.env.FLEET_JOBS_DIR = jobsDir;
	process.env.E2B_API_KEY = "e2b_test_key";

	const now = new Date().toISOString();
	const job: FleetJob = await writeJob({
		jobId: "job-needs-input-refresh",
		profile: "implementer",
		status: "running",
		brief: "ambiguous brief",
		codeAccess: "clone",
		repo: "owner/repo",
		timeoutMinutes: 90,
		dryRun: false,
		sandboxId: "sandbox-needs-input",
		createdAt: now,
		updatedAt: now,
	});

	try {
		const refreshed = await refreshFromSandbox(job, {
			connectSandbox: async () => ({
				files: {
					async read(path: string) {
						if (path === "/work/result.json") {
							return JSON.stringify({
								status: "needs_input",
								questions: [
									"Should this target the v1 or v2 API?",
									"Is a DB migration in scope?",
								],
							});
						}
						throw new Error("not ready");
					},
				},
			}),
		});

		assert.equal(refreshed.status, "needs_input");
		assert.deepEqual(refreshed.questions, [
			"Should this target the v1 or v2 API?",
			"Is a DB migration in scope?",
		]);

		const persisted = await readJob("job-needs-input-refresh");
		assert.equal(persisted.status, "needs_input");
		assert.deepEqual(persisted.questions, [
			"Should this target the v1 or v2 API?",
			"Is a DB migration in scope?",
		]);
	} finally {
		await rm(jobsDir, { recursive: true, force: true });
	}
});

test("sanitizeSecrets redacts exact env values and common GitHub token shapes", () => {
	process.env.FLEET_GITHUB_TOKEN =
		"github_pat_exactTokenValue_abcdefghijklmnopqrstuvwxyz123456";
	process.env.OPENROUTER_API_KEY = "sk-or-worker-secret";

	const sanitized = sanitizeSecrets(
		`token=${process.env.FLEET_GITHUB_TOKEN} provider=${process.env.OPENROUTER_API_KEY} fallback=ghp_abcdefghijklmnopqrstuvwxyz1234567890`,
	);

	assert.equal(sanitized.includes(process.env.FLEET_GITHUB_TOKEN), false);
	assert.equal(sanitized.includes(process.env.OPENROUTER_API_KEY), false);
	assert.equal(sanitized, "token=*** provider=*** fallback=***");
});

test("sanitizeSecrets redacts a GitHub App installation token shape (ghs_...) as a conservative fallback (FLT-6)", () => {
	const sanitized = sanitizeSecrets(
		"minted token=ghs_installationTokenValue1234567890abcd done",
	);
	assert.equal(sanitized, "minted token=*** done");
});

test("sanitizeSecrets redacts the GitHub App private key value when it leaks into text (FLT-6)", () => {
	process.env[GITHUB_APP_ID_ENV] = "123";
	process.env[GITHUB_APP_PRIVATE_KEY_ENV] =
		"-----BEGIN RSA PRIVATE KEY-----\nsuper-secret-key-material\n-----END RSA PRIVATE KEY-----";

	const sanitized = sanitizeSecrets(
		`err: ${process.env[GITHUB_APP_PRIVATE_KEY_ENV]} while minting`,
	);

	assert.equal(sanitized.includes("super-secret-key-material"), false);
	assert.match(sanitized, /^err: \*\*\* while minting$/);
});

test("collectWorkerEnv uses an explicitly supplied githubToken instead of the raw PAT env value (FLT-6)", () => {
	process.env.GH_TOKEN = "ghp_rawPatMustNotBeForwarded1234567890abcd";

	const envs = collectWorkerEnv({ githubToken: "ghs_mintedAppInstallationToken" });

	assert.equal(envs.FLEET_GITHUB_TOKEN, "ghs_mintedAppInstallationToken");
	assert.equal(
		Object.values(envs).includes(process.env.GH_TOKEN as string),
		false,
	);
});

test("collectWorkerEnv falls back to the raw PAT env value when no githubToken override is supplied", () => {
	process.env.GH_TOKEN = "ghp_fallbackPat1234567890abcdefghijkl";

	const envs = collectWorkerEnv();

	assert.equal(envs.FLEET_GITHUB_TOKEN, process.env.GH_TOKEN);
});

test("githubCredentialSourceConfigured is false when neither a PAT nor a GitHub App is configured (FLT-6)", () => {
	assert.equal(githubCredentialSourceConfigured(), false);
});

test("githubCredentialSourceConfigured is true when only FLEET_GITHUB_TOKEN/GH_TOKEN is set (FLT-6)", () => {
	process.env.GH_TOKEN = "ghp_abcdefghijklmnopqrstuvwxyz1234567890";
	assert.equal(githubCredentialSourceConfigured(), true);
});

test("githubCredentialSourceConfigured is true when the GitHub App is fully configured (FLT-6)", () => {
	process.env[GITHUB_APP_ID_ENV] = "123";
	process.env[GITHUB_APP_INSTALLATION_ID_ENV] = "456";
	process.env[GITHUB_APP_PRIVATE_KEY_ENV] = "-----BEGIN RSA PRIVATE KEY-----\nkey\n-----END RSA PRIVATE KEY-----";
	assert.equal(githubCredentialSourceConfigured(), true);
});

test("githubCredentialSourceConfigured throws a clear error when the GitHub App is only partially configured, even if a PAT is also set (FLT-6)", () => {
	process.env.GH_TOKEN = "ghp_abcdefghijklmnopqrstuvwxyz1234567890";
	process.env[GITHUB_APP_ID_ENV] = "123";
	// installationId and private key deliberately left unset — misconfiguration
	// must be a hard error, never silently masked by a valid PAT fallback.

	assert.throws(() => githubCredentialSourceConfigured(), /partially configured/i);
});

test("resolveInjectedGithubToken mints a GitHub App installation token instead of returning the raw PAT when the App is configured (FLT-6)", async () => {
	process.env.GH_TOKEN = "ghp_rawPatMustNotBeForwarded1234567890abcd";
	process.env[GITHUB_APP_ID_ENV] = "123";
	process.env[GITHUB_APP_INSTALLATION_ID_ENV] = "456";
	process.env[GITHUB_APP_PRIVATE_KEY_ENV] = generateTestRsaPrivateKey();

	const token = await resolveInjectedGithubToken({
		fetchImpl: (async () =>
			new Response(JSON.stringify({ token: "ghs_mintedToken", expires_at: "2026-01-01T00:00:00Z" }), {
				status: 201,
			})) as typeof fetch,
	});

	assert.equal(token, "ghs_mintedToken");
});

test("resolveInjectedGithubToken narrows the minted App token to the cast's target repo (FLT-12)", async () => {
	process.env[GITHUB_APP_ID_ENV] = "123";
	process.env[GITHUB_APP_INSTALLATION_ID_ENV] = "456";
	process.env[GITHUB_APP_PRIVATE_KEY_ENV] = generateTestRsaPrivateKey();
	let capturedBody: string | undefined;

	await resolveInjectedGithubToken({
		repo: "github.com/some-org/some-other-repo.git",
		fetchImpl: (async (_url: string, init: RequestInit) => {
			capturedBody = init.body as string | undefined;
			return new Response(
				JSON.stringify({ token: "ghs_mintedToken", expires_at: "2026-01-01T00:00:00Z" }),
				{ status: 201 },
			);
		}) as typeof fetch,
	});

	assert.deepEqual(JSON.parse(capturedBody ?? "{}"), { repositories: ["some-other-repo"] });
});

test("resolveInjectedGithubToken mints with the installation's full access when repo is malformed, instead of failing the mint", async () => {
	process.env[GITHUB_APP_ID_ENV] = "123";
	process.env[GITHUB_APP_INSTALLATION_ID_ENV] = "456";
	process.env[GITHUB_APP_PRIVATE_KEY_ENV] = generateTestRsaPrivateKey();
	let capturedBody: string | undefined;

	const token = await resolveInjectedGithubToken({
		repo: "not-a-valid-repo",
		fetchImpl: (async (_url: string, init: RequestInit) => {
			capturedBody = init.body as string | undefined;
			return new Response(
				JSON.stringify({ token: "ghs_mintedToken", expires_at: "2026-01-01T00:00:00Z" }),
				{ status: 201 },
			);
		}) as typeof fetch,
	});

	assert.equal(capturedBody, undefined);
	assert.equal(token, "ghs_mintedToken");
});

test("resolveInjectedGithubToken falls back to the raw PAT when no GitHub App is configured", async () => {
	process.env.GH_TOKEN = "ghp_fallbackPat1234567890abcdefghijkl";
	const token = await resolveInjectedGithubToken();
	assert.equal(token, process.env.GH_TOKEN);
});

test("resolveInjectedGithubToken returns undefined when neither a PAT nor a GitHub App is configured", async () => {
	assert.equal(await resolveInjectedGithubToken(), undefined);
});

test("non-dry-run cast fails clearly before sandbox creation when GitHub token is missing", async () => {
	const jobsDir = await mkdtemp(join(tmpdir(), "pi-fleet-jobs-"));
	process.env.FLEET_JOBS_DIR = jobsDir;
	process.env.E2B_API_KEY = "e2b_test_key";
	delete process.env.FLEET_GITHUB_TOKEN;
	delete process.env.GH_TOKEN;
	let sandboxCreated = false;

	try {
		const job = await castJob(
			{
				profile: "implementer",
				brief: "implement FLT-2",
				codeAccess: "clone",
				repo: "owner/repo",
			},
			{
				createSandbox: async () => {
					sandboxCreated = true;
					return { sandboxId: "sandbox", logTail: "started" };
				},
			},
		);

		assert.equal(sandboxCreated, false);
		assert.equal(job.dryRun, false);
		assert.equal(job.status, "failed");
		assert.match(job.error ?? "", /FLEET_GITHUB_TOKEN.*GH_TOKEN/);

		const persisted = await readJob(job.jobId);
		assert.equal(persisted.status, "failed");
		assert.match(persisted.error ?? "", /FLEET_GITHUB_TOKEN.*GH_TOKEN/);
	} finally {
		await rm(jobsDir, { recursive: true, force: true });
	}
});

test("non-dry-run cast fails clearly before sandboxId when FLEET_E2B_TEMPLATE is missing", async () => {
	const jobsDir = await mkdtemp(join(tmpdir(), "pi-fleet-jobs-"));
	process.env.FLEET_JOBS_DIR = jobsDir;
	process.env.E2B_API_KEY = "e2b_test_key";
	process.env.FLEET_GITHUB_TOKEN = "ghp_abcdefghijklmnopqrstuvwxyz1234567890";
	delete process.env.FLEET_E2B_TEMPLATE;

	try {
		// No `createSandbox` override: this exercises the real tryCreateSandbox,
		// whose missing-template check must throw before it ever imports the e2b
		// SDK or makes a network call — regression test for the "Cannot read
		// properties of undefined (reading 'version')" crash seen when
		// FLEET_E2B_TEMPLATE was unset.
		const job = await castJob({
			profile: "implementer",
			brief: "implement FLT-3",
			codeAccess: "clone",
			repo: "owner/repo",
		});

		assert.equal(job.dryRun, false);
		assert.equal(job.status, "failed");
		assert.equal(job.sandboxId, undefined);
		assert.equal(job.error, MISSING_TEMPLATE_ERROR);

		const persisted = await readJob(job.jobId);
		assert.equal(persisted.status, "failed");
		assert.equal(persisted.error, MISSING_TEMPLATE_ERROR);
	} finally {
		await rm(jobsDir, { recursive: true, force: true });
	}
});

test("non-dry-run cast fails fast before sandbox creation when FLEET_REPO_URL is missing", async () => {
	const jobsDir = await mkdtemp(join(tmpdir(), "pi-fleet-jobs-"));
	process.env.FLEET_JOBS_DIR = jobsDir;
	process.env.E2B_API_KEY = "e2b_test_key";
	process.env.FLEET_GITHUB_TOKEN = "ghp_abcdefghijklmnopqrstuvwxyz1234567890";
	process.env.FLEET_E2B_TEMPLATE = "pi-fleet-node22";
	delete process.env.FLEET_REPO_URL;

	try {
		// Real tryCreateSandbox: the FLEET_REPO_URL check must throw before the e2b
		// SDK is imported or any sandbox is created — otherwise the runner would
		// emit `git clone ''` inside a billed sandbox (FLT-4 blocker #1).
		const job = await castJob({
			profile: "implementer",
			brief: "implement FLT-4",
			codeAccess: "clone",
			repo: "owner/repo",
		});

		assert.equal(job.status, "failed");
		assert.equal(job.sandboxId, undefined);
		assert.equal(job.error, MISSING_FLEET_REPO_URL_ERROR);

		const persisted = await readJob(job.jobId);
		assert.equal(persisted.status, "failed");
		assert.equal(persisted.error, MISSING_FLEET_REPO_URL_ERROR);
	} finally {
		await rm(jobsDir, { recursive: true, force: true });
	}
});

interface RecordingSandbox extends RunnableSandbox {
	readonly calls: string[];
	killed: number;
}

function recordingSandbox(opts: {
	sandboxId?: string;
	failOn?: RegExp;
} = {}): RecordingSandbox {
	const calls: string[] = [];
	const sandbox: RecordingSandbox = {
		sandboxId: "sandboxId" in opts ? opts.sandboxId : "sbx-mock",
		calls,
		killed: 0,
		files: {
			async write(path: string) {
				calls.push(`write:${path}`);
			},
		},
		commands: {
			async run(command: string) {
				calls.push(`run:${command}`);
				if (opts.failOn?.test(command)) {
					throw new Error(`command failed: ${command}`);
				}
				return {};
			},
		},
		async kill() {
			sandbox.killed += 1;
		},
	};
	return sandbox;
}

function tryCreateSandboxEnv() {
	process.env.E2B_API_KEY = "e2b_test_key";
	process.env.FLEET_E2B_TEMPLATE = "pi-fleet-node22";
	process.env.FLEET_REPO_URL = "https://github.com/owner/pi-fleet.git";
}

test("tryCreateSandbox chmods /work as root BEFORE writing the runner, then backgrounds it", async () => {
	tryCreateSandboxEnv();
	const sandbox = recordingSandbox();

	const result = await tryCreateSandbox(implementerJob(), async () => sandbox);

	assert.equal(result.sandboxId, "sbx-mock");
	// Exact ordering: root chmod of /work must precede the runner write, and the
	// executable bit + backgrounded runner follow it. codeAccess=clone (the
	// implementerJob() default) also uploads the source archive (FLT-9) before
	// run-job.sh, since the runner needs it present the moment it starts.
	assert.deepEqual(sandbox.calls, [
		"run:mkdir -p /work && chmod -R a+rwX /work",
		`write:${REPO_SOURCE_ARCHIVE_PATH}`,
		"write:/work/run-job.sh",
		"run:chmod +x /work/run-job.sh",
		"run:bash -lc 'nohup /work/run-job.sh >/work/job.log 2>&1 & echo $! > /work/job.pid'",
	]);
	assert.equal(sandbox.killed, 0);
});

test("tryCreateSandbox does not upload a source archive for codeAccess=pr/branch (only clone needs it)", async () => {
	tryCreateSandboxEnv();

	const prSandbox = recordingSandbox({ sandboxId: "sbx-pr" });
	await tryCreateSandbox(
		implementerJob({ codeAccess: "pr", prNumber: 7 }),
		async () => prSandbox,
	);
	assert.equal(
		prSandbox.calls.some((c) => c === `write:${REPO_SOURCE_ARCHIVE_PATH}`),
		false,
	);

	const branchSandbox = recordingSandbox({ sandboxId: "sbx-branch" });
	await tryCreateSandbox(
		implementerJob({ codeAccess: "branch", branch: "feature/x" }),
		async () => branchSandbox,
	);
	assert.equal(
		branchSandbox.calls.some((c) => c === `write:${REPO_SOURCE_ARCHIVE_PATH}`),
		false,
	);
});

test("tryCreateSandbox kills the sandbox when a setup command fails", async () => {
	tryCreateSandboxEnv();
	const sandbox = recordingSandbox({ failOn: /nohup/ });

	await assert.rejects(
		() => tryCreateSandbox(implementerJob(), async () => sandbox),
		/sbx-mock started but runner setup failed: command failed/,
	);
	assert.equal(sandbox.killed, 1);
});

test("tryCreateSandbox kills and fails clearly when create() yields no sandboxId", async () => {
	tryCreateSandboxEnv();
	const sandbox = recordingSandbox({ sandboxId: undefined });

	await assert.rejects(
		() => tryCreateSandbox(implementerJob(), async () => sandbox),
		(err: Error) =>
			/returned no sandboxId/.test(err.message) &&
			!/started but/.test(err.message),
	);
	// No id to run setup against, so we never issued setup commands…
	assert.deepEqual(sandbox.calls, []);
	// …but we still best-effort killed whatever create() handed back.
	assert.equal(sandbox.killed, 1);
});

test("isOpaqueVersionError detects the SDK envd version crash across phrasings", () => {
	assert.equal(
		isOpaqueVersionError(
			new Error("Cannot read properties of undefined (reading 'version')"),
		),
		true,
	);
	// JSC/WebKit phrasing
	assert.equal(
		isOpaqueVersionError(
			new Error("undefined is not an object (evaluating 'e.version')"),
		),
		true,
	);
	assert.equal(isOpaqueVersionError("null has no property version"), false);
	// Unrelated SDK errors must pass through untouched.
	assert.equal(
		isOpaqueVersionError(new Error("Unauthorized, please check your credentials")),
		false,
	);
	assert.equal(
		isOpaqueVersionError(
			new Error("You need to update the template to use the new SDK."),
		),
		false,
	);
});

test("describeSandboxError rewraps the opaque version crash but preserves other errors", () => {
	const wrapped = describeSandboxError(
		new Error("Cannot read properties of undefined (reading 'version')"),
	);
	assert.ok(wrapped.startsWith(SANDBOX_VERSION_ERROR_HINT));
	assert.match(wrapped, /original SDK error/);
	assert.match(wrapped, /FLEET_E2B_TEMPLATE/);

	const passthrough = describeSandboxError(new Error("Unauthorized"));
	assert.equal(passthrough, "Unauthorized");
});

test("non-dry-run cast surfaces the actionable hint when the SDK throws the opaque version error", async () => {
	const jobsDir = await mkdtemp(join(tmpdir(), "pi-fleet-jobs-"));
	process.env.FLEET_JOBS_DIR = jobsDir;
	process.env.E2B_API_KEY = "e2b_test_key";
	process.env.FLEET_GITHUB_TOKEN = "ghp_abcdefghijklmnopqrstuvwxyz1234567890";

	try {
		const job = await castJob(
			{
				profile: "implementer",
				brief: "implement FLT-3",
				codeAccess: "clone",
				repo: "owner/repo",
			},
			{
				createSandbox: async () => {
					throw new Error(
						"Cannot read properties of undefined (reading 'version')",
					);
				},
			},
		);

		assert.equal(job.status, "failed");
		assert.equal(job.sandboxId, undefined);
		assert.ok((job.error ?? "").startsWith(SANDBOX_VERSION_ERROR_HINT));

		const persisted = await readJob(job.jobId);
		assert.equal(persisted.status, "failed");
		assert.match(persisted.error ?? "", /republish it with the matching CLI/);
	} finally {
		await rm(jobsDir, { recursive: true, force: true });
	}
});

test("refreshFromSandbox sanitizes remote result fields and log tails before persisting", async () => {
	const jobsDir = await mkdtemp(join(tmpdir(), "pi-fleet-jobs-"));
	process.env.FLEET_JOBS_DIR = jobsDir;
	process.env.E2B_API_KEY = "e2b_test_key";
	process.env.FLEET_GITHUB_TOKEN =
		"github_pat_remoteSecretValue_abcdefghijklmnopqrstuvwxyz123456";
	process.env.OPENAI_API_KEY = "sk-worker-remote-secret";

	const now = new Date().toISOString();
	const job: FleetJob = await writeJob({
		jobId: "job-sanitize",
		profile: "implementer",
		status: "running",
		brief: "brief",
		codeAccess: "clone",
		repo: "owner/repo",
		timeoutMinutes: 90,
		dryRun: false,
		sandboxId: "sandbox-id",
		createdAt: now,
		updatedAt: now,
	});

	try {
		const refreshed = await refreshFromSandbox(job, {
			connectSandbox: async () => ({
				files: {
					async read(path: string) {
						if (path === "/work/result.json") {
							return JSON.stringify({
								status: "failed",
								error: `remote error leaked ${process.env.FLEET_GITHUB_TOKEN}`,
								blockers: [`model leaked ${process.env.OPENAI_API_KEY}`],
							});
						}
						if (path === "/work/job.log") {
							return `log leaked ${process.env.FLEET_GITHUB_TOKEN} and ${process.env.OPENAI_API_KEY}`;
						}
						throw new Error("unexpected path");
					},
				},
			}),
		});

		assert.equal(refreshed.status, "failed");
		assert.equal(
			refreshed.error?.includes(process.env.FLEET_GITHUB_TOKEN),
			false,
		);
		assert.equal(
			refreshed.logTail?.includes(process.env.FLEET_GITHUB_TOKEN),
			false,
		);
		assert.equal(
			refreshed.blockers?.join(" ").includes(process.env.OPENAI_API_KEY),
			false,
		);
		assert.match(refreshed.error ?? "", /\*\*\*/);

		const persistedRaw = await readFile(
			join(jobsDir, "job-sanitize.json"),
			"utf8",
		);
		assert.equal(persistedRaw.includes(process.env.FLEET_GITHUB_TOKEN), false);
		assert.equal(persistedRaw.includes(process.env.OPENAI_API_KEY), false);
	} finally {
		await rm(jobsDir, { recursive: true, force: true });
	}
});

// --- FLT-45: reviewer-profile cast path -------------------------------------

function reviewerJob(overrides: Partial<FleetJob> = {}): FleetJob {
	const now = new Date().toISOString();
	return {
		jobId: "job-review-12345678",
		profile: "reviewer",
		status: "queued",
		brief: "Focus on auth and input validation.",
		codeAccess: "pr",
		repo: "owner/repo",
		prNumber: 42,
		timeoutMinutes: 90,
		dryRun: false,
		createdAt: now,
		updatedAt: now,
		...overrides,
	};
}

test("resolveGithubReviewerToken prefers FLEET_GITHUB_REVIEWER_TOKEN over the implementer's push token", () => {
	process.env.FLEET_GITHUB_TOKEN = "ghp_implementerPushToken1234567890abcdef";
	process.env.FLEET_GITHUB_REVIEWER_TOKEN = "ghp_reviewerScopedToken1234567890abcdef";

	assert.equal(resolveGithubReviewerToken(), process.env.FLEET_GITHUB_REVIEWER_TOKEN);
	assert.equal(githubReviewerTokenPresent(), true);
});

test("resolveGithubReviewerToken falls back to the implementer's GitHub token keys when unset", () => {
	delete process.env.FLEET_GITHUB_REVIEWER_TOKEN;
	process.env.GH_TOKEN = "ghp_fallbackToken1234567890abcdefghijkl";

	assert.equal(resolveGithubReviewerToken(), process.env.GH_TOKEN);
	assert.equal(githubReviewerTokenPresent(), true);
});

test("githubReviewerTokenPresent is false when no GitHub token env var is set", () => {
	assert.equal(githubReviewerTokenPresent(), false);
	assert.equal(resolveGithubReviewerToken(), undefined);
});

test("resolveInjectedGithubToken resolves the reviewer-scoped token for profile=reviewer when no GitHub App is configured", async () => {
	process.env.FLEET_GITHUB_TOKEN = "ghp_implementerPushToken1234567890abcdef";
	process.env.FLEET_GITHUB_REVIEWER_TOKEN = "ghp_reviewerScopedToken1234567890abcdef";

	assert.equal(
		await resolveInjectedGithubToken({ profile: "reviewer" }),
		"ghp_reviewerScopedToken1234567890abcdef",
	);
	assert.equal(
		await resolveInjectedGithubToken({ profile: "implementer" }),
		"ghp_implementerPushToken1234567890abcdef",
	);
});

test("collectWorkerEnv ships the reviewer-resolved token under the canonical FLEET_GITHUB_TOKEN name", async () => {
	process.env.FLEET_GITHUB_TOKEN = "ghp_implementerPushToken1234567890abcdef";
	process.env.FLEET_GITHUB_REVIEWER_TOKEN = "ghp_reviewerScopedToken1234567890abcdef";
	process.env.OPENAI_API_KEY = "sk-worker-openai";

	const githubToken = await resolveInjectedGithubToken({ profile: "reviewer" });
	assert.deepEqual(collectWorkerEnv({ githubToken }), {
		FLEET_GITHUB_TOKEN: "ghp_reviewerScopedToken1234567890abcdef",
		OPENAI_API_KEY: "sk-worker-openai",
	});
});

test("githubCredentialSourceConfigured checks the reviewer-scoped token for profile=reviewer, independent of the implementer's token", () => {
	assert.equal(githubCredentialSourceConfigured("reviewer"), false);
	assert.equal(githubCredentialSourceConfigured("implementer"), false);

	process.env.FLEET_GITHUB_REVIEWER_TOKEN = "ghp_reviewerScopedToken1234567890abcdef";
	assert.equal(githubCredentialSourceConfigured("reviewer"), true);
	// The reviewer-scoped token alone must not satisfy the implementer's check.
	assert.equal(githubCredentialSourceConfigured("implementer"), false);
});

test("buildReviewerRunnerScript never embeds token values", () => {
	process.env.FLEET_REPO_URL = "https://github.com/owner/pi-fleet.git";
	process.env.FLEET_GITHUB_REVIEWER_TOKEN =
		"github_pat_thisSecretMustNotAppearInTheReviewerScript12345";
	const script = buildReviewerRunnerScript(reviewerJob());

	assert.equal(
		script.includes(process.env.FLEET_GITHUB_REVIEWER_TOKEN),
		false,
	);
	assert.match(script, /FLEET_GITHUB_TOKEN/);
});

test("buildReviewerRunnerScript fetches the PR read-only and never runs a code-mutating command", () => {
	process.env.FLEET_REPO_URL = "https://github.com/owner/pi-fleet.git";
	const script = buildReviewerRunnerScript(reviewerJob({ repo: "owner/private-app", prNumber: 7 }));

	assert.match(script, /export TARGET_REPO='owner\/private-app'/);
	assert.match(script, /export PR_NUMBER='7'/);
	assert.match(script, /gh pr view "\$PR_NUMBER" --repo "\$TARGET_REPO"/);
	assert.match(script, /gh pr diff "\$PR_NUMBER" --repo "\$TARGET_REPO" > \/work\/pr-diff\.patch/);
	assert.match(script, /gh pr comment "\$PR_NUMBER" --repo "\$TARGET_REPO" --body-file/);

	// The distinguishing guarantee of a reviewer cast: no command that could
	// mutate the target repo or the PR's merge state ever appears. Cloning the
	// pi-fleet *tooling* repo (for bin/pi-reviewer + profiles/skills) is fine —
	// it's never the reviewed target repo, which this script never clones,
	// checks out, pushes to, or commits into.
	assert.doesNotMatch(script, /git push/);
	assert.doesNotMatch(script, /git commit/);
	assert.doesNotMatch(script, /git checkout/);
	assert.doesNotMatch(script, /gh pr merge/);
	assert.doesNotMatch(script, /gh pr review/);
	assert.doesNotMatch(script, /gh repo clone/);
	assert.doesNotMatch(script, /git clone.*private-app/);
});

test("buildReviewerRunnerScript invokes pi-reviewer (not pi-implementer) and anchors its profile", () => {
	process.env.FLEET_REPO_URL = "https://github.com/owner/pi-fleet.git";
	const script = buildReviewerRunnerScript(reviewerJob());

	assert.match(script, /"\$PI_REVIEW".*-p "\$\(cat \/work\/brief\.md\)"/);
	assert.doesNotMatch(script, /pi-implementer/);
	assert.match(script, /default_profile: reviewer/);
	assert.match(script, /- path: \/work\/pi-fleet\/profiles/);
});

test("buildReviewerRunnerScript emits a matched --provider/--model pair before -p when both are set on the job (FLT-45 model-auth fix)", () => {
	process.env.FLEET_REPO_URL = "https://github.com/owner/pi-fleet.git";

	const overridden = buildReviewerRunnerScript(
		reviewerJob({ provider: "anthropic", model: "some-model" }),
	);
	assert.match(
		overridden,
		/"\$PI_REVIEW" --provider 'anthropic' --model 'some-model' -p "\$\(cat \/work\/brief\.md\)"/,
	);

	// No override: falls through to the profile's own default (openai-codex /
	// gpt-5.5 per profiles/reviewer/profile.yml) — no --provider/--model flags
	// at all, exactly like the implementer runner's equivalent no-override case.
	const defaulted = buildReviewerRunnerScript(reviewerJob());
	assert.match(defaulted, /"\$PI_REVIEW" -p "\$\(cat \/work\/brief\.md\)"/);
	assert.doesNotMatch(defaulted, /--provider|--model/);
});

test("buildReviewerRunnerScript cd's into a /work subdirectory before invoking pi-reviewer, so profile.yml's ../extensions/linear.ts resolves to the symlinked /work/extensions (regression: sandbox previously ran pi-reviewer from a shallower cwd, resolving to the nonexistent /extensions/linear.ts)", () => {
	process.env.FLEET_REPO_URL = "https://github.com/owner/pi-fleet.git";
	const script = buildReviewerRunnerScript(reviewerJob());

	const cdMatch = script.match(/^cd (\/work\/\S+)$/m);
	assert.ok(cdMatch, "expected an explicit `cd /work/<subdir>` before invoking pi-reviewer");
	const reviewerCwd = cdMatch![1];

	// The actual invariant that broke: pi resolves a profile's `../extensions/x`
	// relative to its own cwd (not the profile file's location — see the
	// symlink comment in buildRunnerScript/buildReviewerRunnerScript), and the
	// runner only ever symlinks pi-fleet's extensions to /work/extensions. So
	// resolving "../extensions/linear.ts" against whatever cwd we cd into must
	// land exactly on /work/extensions/linear.ts, or pi-reviewer fails to load
	// its Linear extension with "Failed to load extension ...".
	assert.equal(
		path.join(reviewerCwd, "..", "extensions", "linear.ts"),
		"/work/extensions/linear.ts",
	);

	// Ordering: the cd must land before pi-reviewer is invoked, not after.
	const cdIdx = script.indexOf(`cd ${reviewerCwd}`);
	const invokeIdx = script.indexOf('"$PI_REVIEW"');
	assert.ok(cdIdx !== -1 && cdIdx < invokeIdx);

	// mkdir -p must precede the cd, or a fresh sandbox has nothing to cd into.
	assert.match(script, new RegExp(`mkdir -p ${reviewerCwd.replace(/\//g, "\\/")}\\ncd ${reviewerCwd.replace(/\//g, "\\/")}`));
});

test("buildReviewerRunnerScript logs each read-only gh call to the evidence file", () => {
	process.env.FLEET_REPO_URL = "https://github.com/owner/pi-fleet.git";
	const script = buildReviewerRunnerScript(reviewerJob());

	assert.match(script, />> "\$EVIDENCE"/);
	assert.match(script, /gh pr view .* \(read-only\)/);
	assert.match(script, /gh pr diff .* \(read-only\)/);
	assert.match(script, /gh pr comment .* \(comment only, no approve\/request-changes authority\)/);
});

test("buildReviewerRunnerScript logs the same job-lifecycle lines the implementer runner uses, so reconnect's log-based jobId fallback still matches", () => {
	process.env.FLEET_REPO_URL = "https://github.com/owner/pi-fleet.git";
	const script = buildReviewerRunnerScript(reviewerJob());

	assert.match(script, /^echo "fleet e2b job \$JOB_ID starting"$/m);
	assert.match(script, /echo "fleet e2b job \$JOB_ID finished status=\$STATUS"/);
});

test("buildReviewerResultFinalizer writes a succeeded result with verdict/findings/reviewUrl/evidence", async () => {
	const work = await mkdtemp(join(tmpdir(), "pi-fleet-work-"));
	try {
		await writeFile(join(work, "review-output.txt"), "VERDICT: APPROVE\nLooks good.");
		await writeFile(
			join(work, "readonly-evidence.log"),
			"gh pr view 42 --repo owner/repo (read-only)\ngh pr diff 42 --repo owner/repo (read-only)\n",
		);

		runReviewerFinalizer(work, {
			JOB_ID: "job-review-ok",
			EXIT: "0",
			TARGET_REPO: "owner/repo",
			PR_NUMBER: "42",
			VERDICT: "APPROVE",
			REVIEW_URL: "https://github.com/owner/repo/pull/42#issuecomment-1",
			REVIEW_OUTPUT: join(work, "review-output.txt"),
			EVIDENCE: join(work, "readonly-evidence.log"),
		});

		const result = JSON.parse(await readFile(join(work, "result.json"), "utf8"));
		assert.equal(result.status, "succeeded");
		assert.equal(result.profile, "reviewer");
		assert.equal(result.jobId, "job-review-ok");
		assert.equal(result.prNumber, 42);
		assert.equal(result.verdict, "APPROVE");
		assert.match(result.findingsSummary, /VERDICT: APPROVE/);
		assert.equal(result.reviewUrl, "https://github.com/owner/repo/pull/42#issuecomment-1");
		assert.deepEqual(result.readOnlyEvidence, [
			"gh pr view 42 --repo owner/repo (read-only)",
			"gh pr diff 42 --repo owner/repo (read-only)",
		]);
		assert.equal(result.error, null);
	} finally {
		await rm(work, { recursive: true, force: true });
	}
});

test("buildReviewerResultFinalizer surfaces a clear error when the PR fetch fails, without a token-access-hint token leak", async () => {
	const work = await mkdtemp(join(tmpdir(), "pi-fleet-work-"));
	try {
		const token = "github_pat_reviewerFetchFailureSecret_abcdefghijklmno";
		process.env.FLEET_GITHUB_REVIEWER_TOKEN = token;
		runReviewerFinalizer(work, {
			JOB_ID: "job-review-fetch-failed",
			EXIT: "1",
			TARGET_REPO: "owner/private-app",
			PR_NUMBER: "99",
			PR_FETCH_FAILED: "1",
		});

		const raw = await readFile(join(work, "result.json"), "utf8");
		const result = JSON.parse(raw);
		assert.equal(result.status, "failed");
		assert.equal(result.verdict, "UNKNOWN");
		assert.match(result.error, /Failed to fetch PR #99/);
		assert.match(result.error, /owner\/private-app/);
		assert.equal(raw.includes(token), false);
	} finally {
		await rm(work, { recursive: true, force: true });
	}
});

test("buildReviewerResultFinalizer marks the job failed when the review succeeded but posting the comment failed", async () => {
	const work = await mkdtemp(join(tmpdir(), "pi-fleet-work-"));
	try {
		await writeFile(join(work, "review-output.txt"), "VERDICT: REQUEST-CHANGES\nMissing null check.");

		runReviewerFinalizer(work, {
			JOB_ID: "job-review-comment-failed",
			EXIT: "0",
			TARGET_REPO: "owner/repo",
			PR_NUMBER: "5",
			VERDICT: "REQUEST-CHANGES",
			COMMENT_POST_FAILED: "1",
			REVIEW_OUTPUT: join(work, "review-output.txt"),
		});

		const result = JSON.parse(await readFile(join(work, "result.json"), "utf8"));
		assert.equal(result.status, "failed");
		// The review itself is still reported even though posting it failed —
		// useful diagnostic, not silently dropped.
		assert.equal(result.verdict, "REQUEST-CHANGES");
		assert.match(result.findingsSummary, /Missing null check/);
		assert.match(result.error, /failed to post the.*comment/);
		assert.equal(result.reviewUrl, null);
	} finally {
		await rm(work, { recursive: true, force: true });
	}
});

test("buildReviewerResultFinalizer falls back to a generic exit-code error and UNKNOWN verdict when pi-reviewer itself fails", async () => {
	const work = await mkdtemp(join(tmpdir(), "pi-fleet-work-"));
	try {
		runReviewerFinalizer(work, {
			JOB_ID: "job-review-bad-exit",
			EXIT: "1",
			TARGET_REPO: "owner/repo",
			PR_NUMBER: "3",
		});

		const result = JSON.parse(await readFile(join(work, "result.json"), "utf8"));
		assert.equal(result.status, "failed");
		assert.equal(result.verdict, "UNKNOWN");
		assert.match(result.error, /pi-reviewer exited 1/);
		assert.equal(result.findingsSummary, null);
	} finally {
		await rm(work, { recursive: true, force: true });
	}
});
