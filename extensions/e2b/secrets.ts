/**
 * pi-fleet E2B extension — secret handling.
 *
 * GitHub tokens, model keys, and the E2B API key are only ever passed through
 * environment variables. They are never embedded in generated scripts and never
 * persisted or logged by this extension. Remote output is sanitized before it
 * is stored in the local job record.
 */
import { REPO_SOURCE_ARCHIVE_PATH } from "./archive.js";
import {
	GITHUB_APP_PRIVATE_KEY_ENV,
	type FetchLike,
	mintInstallationToken,
	resolveGithubAppConfig,
} from "./githubApp.js";
import type { FleetJob } from "./types.js";

export const MISSING_FLEET_REPO_URL_ERROR =
	"FLEET_REPO_URL is required for non-dry-run implementer casts (the pi-fleet repo the sandbox clones for its bin/ wrappers + profiles, e.g. FLEET_REPO_URL=https://github.com/<owner>/pi-fleet.git)";

export const TARGET_REPO_ACCESS_ERROR_HINT =
	"FLEET_GITHUB_TOKEN/GH_TOKEN may not have access to this repository. Verify the repository exists and the token has repository access with Contents read permission.";

/**
 * The pi-fleet repo the sandbox clones to /work/pi-fleet for its bin/ wrappers
 * and profiles. Read at call time (never at module load, so tests and the cast
 * see the current env) and fail fast with a clear error rather than emitting a
 * `git clone ''` that dies with "fatal: repository '' does not exist".
 */
export function resolveFleetRepoUrl(): string {
	const url = process.env.FLEET_REPO_URL?.trim();
	if (!url) throw new Error(MISSING_FLEET_REPO_URL_ERROR);
	return url;
}

export const GITHUB_TOKEN_ENV_KEYS = ["FLEET_GITHUB_TOKEN", "GH_TOKEN"] as const;

export const MISSING_REVIEWER_GITHUB_TOKEN_ERROR =
	"FLEET_GITHUB_REVIEWER_TOKEN (or FLEET_GITHUB_TOKEN/GH_TOKEN) is required for non-dry-run reviewer casts";

/**
 * Reviewer casts prefer a dedicated, narrower-scoped token
 * (FLEET_GITHUB_REVIEWER_TOKEN — e.g. "Pull requests: write" only, no
 * "Contents: write") so reviewer credentials can be documented and rotated
 * separately from the implementer's push/PR-open token (FLT-45 AC). Falling
 * back to the implementer keys keeps a reviewer cast usable with zero extra
 * setup; the runner itself never runs a code-mutating command regardless of
 * which token is resolved, so this is defense in depth, not the only guard.
 */
export const GITHUB_REVIEWER_TOKEN_ENV_KEYS = [
	"FLEET_GITHUB_REVIEWER_TOKEN",
	...GITHUB_TOKEN_ENV_KEYS,
] as const;

export const FLEET_WORKER_MODEL_KEYS = [
	"OPENAI_API_KEY",
	"OPENROUTER_API_KEY",
	"ANTHROPIC_API_KEY",
	"XAI_API_KEY",
	"GEMINI_API_KEY",
	"GOOGLE_API_KEY",
	"KIMI_API_KEY",
	"MOONSHOT_API_KEY",
] as const;

// Base64 of the local pi agent auth blob (`~/.pi/agent/auth.json`). pi uses
// OAuth (not an API key) for providers like openai-codex, so the sandbox can't
// authenticate from *_API_KEY env vars alone. When set locally, this is
// forwarded into the sandbox and materialized to `$HOME/.pi/agent/auth.json`.
export const PI_AGENT_AUTH_ENV = "PI_AGENT_AUTH_JSON_B64";

/** Path the runner writes the decoded pi auth blob to inside the sandbox. */
export const PI_AGENT_AUTH_PATH = "$HOME/.pi/agent/auth.json";

/**
 * profiles/reviewer/profile.yml defaults to provider=openai-codex, which pi
 * authenticates via OAuth (PI_AGENT_AUTH_ENV), not an API key — so a reviewer
 * cast with neither an explicit provider+model override nor a forwarded OAuth
 * blob is guaranteed to fail deep inside pi's launch with an opaque "No API
 * key found for <provider>" only after a sandbox is already billed (observed
 * live: jobs ab043369, 9e9c2a4f). Caught here instead, before any sandbox is
 * created — same "fail fast, never silently reach a doomed sandbox" pattern
 * as MISSING_GITHUB_TOKEN_ERROR/MISSING_TEMPLATE_ERROR.
 */
export const MISSING_REVIEWER_MODEL_AUTH_ERROR =
	`profiles/reviewer/profile.yml defaults to provider=openai-codex, which pi authenticates via OAuth, not an API key. ` +
	`Either export ${PI_AGENT_AUTH_ENV} (base64 of ~/.pi/agent/auth.json) locally so it is forwarded into the sandbox, ` +
	`or pass an explicit e2b_cast provider+model pair (both together — see requireReviewerCast) pointing at a provider ` +
	`authenticated via one of the already-forwarded FLEET_WORKER_MODEL_KEYS (${FLEET_WORKER_MODEL_KEYS.join(", ")}).`;

/** All env keys that may hold sensitive values; used for log sanitization. */
export const SENSITIVE_ENV_KEYS = [
	...GITHUB_REVIEWER_TOKEN_ENV_KEYS,
	"E2B_API_KEY",
	PI_AGENT_AUTH_ENV,
	GITHUB_APP_PRIVATE_KEY_ENV,
	...FLEET_WORKER_MODEL_KEYS,
];

/**
 * agents/implementer.md has no built-in awareness of the E2B needs-input
 * marker convention — it's sandbox-only, so it's injected here rather than
 * into the general implementer prompt. Prepended to every job's brief so a
 * genuinely ambiguous real cast can actually reach `needs_input` instead of
 * guessing or failing outright.
 */
const NEEDS_INPUT_BRIEF_PREAMBLE = `Sandbox note: if this task is genuinely ambiguous and you cannot proceed safely without a human decision, do not guess and do not fail the job. Instead write /work/needs-input.json as {"questions": ["...", "..."]} listing exactly what you need answered, then exit 0.`;

/**
 * Reduce any of the repo shapes this fleet is fed (owner/repo,
 * owner/repo.git, github.com/owner/repo[.git], with or without an
 * https:// scheme) to the bare `owner/repo` slug `gh` unambiguously
 * resolves. Without this, `gh repo clone github.com/owner/repo.git`
 * strips the host but keeps the literal `.git` suffix as part of the repo
 * name, and GitHub can't resolve it (see FLT-4).
 */
export function normalizeRepoSlug(repo: string): string {
	let slug = repo.trim();
	slug = slug.replace(/^git@github\.com:/, "");
	slug = slug.replace(/^https?:\/\//, "");
	slug = slug.replace(/^github\.com\//, "");
	slug = slug.replace(/\.git$/, "");
	slug = slug.replace(/\/$/, "");

	if (!/^[^/]+\/[^/]+$/.test(slug)) {
		throw new Error(`Invalid repo slug: expected "owner/repo", got ${JSON.stringify(repo)}`);
	}
	return slug;
}

export function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function githubTokenPresent(): boolean {
	return GITHUB_TOKEN_ENV_KEYS.some((key) => Boolean(process.env[key]?.trim()));
}

export function resolveGithubToken(): string | undefined {
	for (const key of GITHUB_TOKEN_ENV_KEYS) {
		const v = process.env[key]?.trim();
		if (v) return v;
	}
	return undefined;
}

export function githubReviewerTokenPresent(): boolean {
	return GITHUB_REVIEWER_TOKEN_ENV_KEYS.some((key) =>
		Boolean(process.env[key]?.trim()),
	);
}

export function resolveGithubReviewerToken(): string | undefined {
	for (const key of GITHUB_REVIEWER_TOKEN_ENV_KEYS) {
		const v = process.env[key]?.trim();
		if (v) return v;
	}
	return undefined;
}

export interface CollectWorkerEnvOptions {
	/**
	 * Pre-resolved token to forward as FLEET_GITHUB_TOKEN (e.g. a freshly
	 * minted GitHub App installation token — see {@link resolveInjectedGithubToken}).
	 * Takes precedence over the raw FLEET_GITHUB_TOKEN/GH_TOKEN env value so a
	 * sandbox never receives the long-lived PAT when an App token was minted.
	 */
	githubToken?: string;
}

/** Collect the secrets that should be injected into the E2B sandbox env. */
export function collectWorkerEnv(
	opts: CollectWorkerEnvOptions = {},
): Record<string, string> {
	const envs: Record<string, string> = {};
	const gh = opts.githubToken ?? resolveGithubToken();
	if (gh) envs.FLEET_GITHUB_TOKEN = gh;
	for (const key of FLEET_WORKER_MODEL_KEYS) {
		const v = process.env[key]?.trim();
		if (v) envs[key] = v;
	}
	const piAuth = process.env[PI_AGENT_AUTH_ENV]?.trim();
	if (piAuth) envs[PI_AGENT_AUTH_ENV] = piAuth;
	return envs;
}

/**
 * True when a usable GitHub credential source is configured for `profile`:
 * either a fully configured GitHub App (shared across profiles — its
 * installation token's permissions are set on the App itself, not per
 * fleet-side profile), or the profile's legacy PAT — the reviewer-scoped
 * GITHUB_REVIEWER_TOKEN_ENV_KEYS precedence for "reviewer", the implementer's
 * GITHUB_TOKEN_ENV_KEYS otherwise (FLT-45 keeps these documented separately
 * in docs/e2b-reviewer.md even though both share the App tier). Throws when
 * the GitHub App is only partially configured (see {@link resolveGithubAppConfig}) —
 * that state must never silently fall back to the PAT, since it masks a
 * broken App setup as "working as before".
 */
export function githubCredentialSourceConfigured(
	profile: FleetJob["profile"] = "implementer",
): boolean {
	if (resolveGithubAppConfig()) return true;
	return profile === "reviewer" ? githubReviewerTokenPresent() : githubTokenPresent();
}

export interface ResolveInjectedGithubTokenOptions {
	fetchImpl?: FetchLike;
	profile?: FleetJob["profile"];
}

/**
 * Resolves the token to inject into the sandbox as FLEET_GITHUB_TOKEN: a
 * freshly minted, short-lived GitHub App installation token when an App is
 * configured (the private key itself never leaves this call — shared across
 * profiles, see {@link githubCredentialSourceConfigured}), otherwise the
 * profile's legacy PAT (reviewer-scoped for "reviewer", implementer's
 * FLEET_GITHUB_TOKEN/GH_TOKEN otherwise). Returns undefined when neither is
 * configured.
 */
export async function resolveInjectedGithubToken(
	opts: ResolveInjectedGithubTokenOptions = {},
): Promise<string | undefined> {
	const appConfig = resolveGithubAppConfig();
	if (appConfig) {
		const { token } = await mintInstallationToken(appConfig, {
			fetchImpl: opts.fetchImpl,
		});
		return token;
	}
	return opts.profile === "reviewer" ? resolveGithubReviewerToken() : resolveGithubToken();
}

/** Return a copy of `text` with any known secret values redacted. */
export function sanitizeSecrets(text: string): string {
	let sanitized = text;

	// Exact env values first (most reliable). Use split/join to avoid regex
	// escaping issues when the token contains special characters.
	for (const key of SENSITIVE_ENV_KEYS) {
		const value = process.env[key]?.trim();
		if (!value || value.length < 1) continue;
		if (sanitized.includes(value)) {
			sanitized = sanitized.split(value).join("***");
		}
	}

	// Conservative fallback for common GitHub token formats that may appear in
	// remote process output even when the literal env value is not matched.
	sanitized = sanitized
		.replace(/github_pat_[A-Za-z0-9_]{30,}/g, "***")
		.replace(/ghp_[A-Za-z0-9]{30,}/g, "***")
		.replace(/gho_[A-Za-z0-9]{30,}/g, "***")
		// ghs_ = GitHub App installation access token (FLT-6).
		.replace(/ghs_[A-Za-z0-9]{30,}/g, "***");

	return sanitized;
}

/**
 * Emit the bash that turns the remote worker's exit state into
 * `$WORK/result.json`.
 *
 * A pi-implementer that finished cleanly or failed hard is decided by its exit
 * code. But some briefs are ambiguous and the implementer needs a human to
 * disambiguate before it can proceed — for that it drops a well-known marker
 * file, `$WORK/needs-input.json`, shaped `{ "questions": ["..."] }`. (No such
 * convention exists in the fleet/outfitter today, so this defines it.) When the
 * marker is present we emit `status="needs_input"` with the questions instead
 * of masquerading as a success/failure, so the project lead can answer and
 * re-cast.
 *
 * Precedence: a result.json written by pi-implementer itself is authoritative
 * and left untouched; otherwise the needs-input marker wins over the exit code;
 * otherwise the exit code decides succeeded/failed. `$STATUS` is re-derived
 * from the persisted result.json after this runs, so a caller echoing it (e.g.
 * the final "job finished status=$STATUS" log line) never contradicts what
 * was actually written to disk. Kept as a standalone, `$WORK`-relative snippet
 * (no git/gh dependencies) so it is unit-testable in isolation.
 */
export function buildResultFinalizer(): string {
	return `WORK="\${WORK:-/work}"
RESULT="$WORK/result.json"
NEEDS_INPUT_FILE="$WORK/needs-input.json"
if [ "\${TARGET_REPO_CLONE_FAILED:-0}" = "1" ]; then
  STATUS=failed
elif [ "\${SOURCE_ARCHIVE_EXTRACT_FAILED:-0}" = "1" ]; then
  STATUS=failed
elif [ "\${BRANCH_CHECKOUT_FAILED:-0}" = "1" ]; then
  STATUS=failed
elif [ -f "$NEEDS_INPUT_FILE" ]; then
  STATUS=needs_input
elif [ "\${EXIT:-1}" -eq 0 ]; then
  STATUS=succeeded
else
  STATUS=failed
fi
export STATUS RESULT NEEDS_INPUT_FILE
if [ ! -f "$RESULT" ]; then
  python3 - <<'PY'
import datetime, json, os

status = os.environ.get("STATUS", "failed")
exit_code = os.environ.get("EXIT", "1")
marker = os.environ.get("NEEDS_INPUT_FILE", "")

questions = []
if status == "needs_input" and marker and os.path.exists(marker):
    try:
        with open(marker, encoding="utf-8") as fh:
            data = json.load(fh)
        raw = data.get("questions") if isinstance(data, dict) else None
        if isinstance(raw, list):
            questions = [str(q).strip() for q in raw if str(q).strip()]
    except Exception:
        questions = []
    if not questions:
        # Marker present but empty/unparseable: still surface needs_input so the
        # job never masquerades as succeeded, and nudge the lead for detail.
        questions = ["pi-implementer requested input but provided no questions"]

error = None
if os.environ.get("TARGET_REPO_CLONE_FAILED") == "1":
    target_repo = os.environ.get("TARGET_REPO", "unknown")
    error = (
        f"Target repository clone failed for {target_repo}: "
        "${TARGET_REPO_ACCESS_ERROR_HINT}"
    )
elif os.environ.get("SOURCE_ARCHIVE_EXTRACT_FAILED") == "1":
    target_repo = os.environ.get("TARGET_REPO", "unknown")
    error = (
        f"Failed to extract the uploaded source archive for {target_repo} "
        "(sandbox-side tar/base64 unpack error)."
    )
elif os.environ.get("BRANCH_CHECKOUT_FAILED") == "1":
    branch_name = os.environ.get("BRANCH_NAME", "unknown")
    target_repo = os.environ.get("TARGET_REPO", "unknown")
    error = (
        f"Branch '{branch_name}' not found in {target_repo} "
        "(or not accessible with current credentials)."
    )
elif status == "failed":
    error = f"pi-implementer exited {exit_code}"

result = {
    "jobId": os.environ.get("JOB_ID"),
    "profile": "implementer",
    "status": status,
    "commitSha": os.environ.get("SHA") or None,
    "prUrl": os.environ.get("PR_URL") or None,
    "branch": os.environ.get("BRANCH") or None,
    "questions": questions or None,
    "error": error,
    "finishedAt": datetime.datetime.now(datetime.timezone.utc).strftime(
        "%Y-%m-%dT%H:%M:%S.%fZ"
    ),
}
with open(os.environ["RESULT"], "w", encoding="utf-8") as fh:
    json.dump(result, fh, indent=2)
    fh.write("\\n")
PY
fi
STATUS=$(python3 - <<'PY'
import json, os

fallback = os.environ.get("STATUS", "unknown")
try:
    with open(os.environ["RESULT"], encoding="utf-8") as fh:
        data = json.load(fh)
    print(data.get("status") or fallback)
except Exception:
    print(fallback)
PY
)
export STATUS`;
}

/** Build the remote runner script (secrets only via env — never embedded). */
export function buildRunnerScript(job: FleetJob): string {
	const fleetRepo = resolveFleetRepoUrl();
	const fleetRef = job.fleetRef || "develop";
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
	const repo = normalizeRepoSlug(job.repo || "");
	if (job.codeAccess === "pr") {
		checkout = [
			// PR checkout needs a non-shallow clone so gh can fetch the PR ref and
			// set up tracking without "starting point is not a branch" errors.
			"clone_target",
			"cd /work/repo",
			`gh pr checkout ${Number(job.prNumber)}`,
		].join("\n");
	} else if (job.codeAccess === "branch") {
		const branch = job.branch || "";
		checkout = [
			// A full clone + explicit fetch/checkout avoids shallow-clone tracking
			// failures for branches that may not be the repo's default.
			"clone_target",
			"cd /work/repo",
			`export BRANCH_NAME=${shellQuote(branch)}`,
			"checkout_branch",
		].join("\n");
	} else {
		// codeAccess === "clone": FLT-9 — the sandbox never gets read credentials
		// for the target repo. The host uploads a git-archive/tar snapshot of its
		// own local checkout (see archive.ts) to REPO_SOURCE_ARCHIVE_PATH before
		// the runner starts; here we just unpack it and reconstruct a minimal git
		// repo (fresh init + a baseline commit) so the rest of the flow — new
		// branch, then push/PR via the still-injected FLEET_GITHUB_TOKEN — works
		// exactly as it does for a real clone.
		const newBranch = job.branch || `fleet/${job.jobId.slice(0, 8)}`;
		checkout = [
			"extract_source_archive",
			"cd /work/repo",
			"git init -q",
			`git remote add origin ${shellQuote(`https://github.com/${repo}.git`)}`,
			"git add -A",
			'git -c user.email="fleet@pi-fleet.local" -c user.name="pi-fleet" commit -q -m "fleet: source snapshot for codeAccess=clone" --allow-empty',
			`git checkout -b ${shellQuote(newBranch)}`,
		].join("\n");
	}

	return `#!/usr/bin/env bash
set -euo pipefail
export JOB_ID=${shellQuote(job.jobId)}
export TARGET_REPO=${shellQuote(repo)}
WORK=/work
RESULT="$WORK/result.json"
LOG="$WORK/job.log"
mkdir -p /work
exec > >(tee -a "$LOG") 2>&1
echo "fleet e2b job $JOB_ID starting"

cat > /work/brief.md <<'FLEET_BRIEF_EOF'
${NEEDS_INPUT_BRIEF_PREAMBLE}

${job.brief}
FLEET_BRIEF_EOF

# pi-fleet pin
git clone --depth 1 --branch ${shellQuote(fleetRef)} ${shellQuote(fleetRepo)} /work/pi-fleet \\
  || git clone --depth 1 ${shellQuote(fleetRepo)} /work/pi-fleet
export PATH="/work/pi-fleet/bin:$PATH"

# Anchor Outfitter profile resolution to the cloned pi-fleet repo. The bin/pi-*
# wrappers run \`outfitter run --profile <id>\`, which resolves profiles from
# $HOME/.outfitter/settings.yml or <cwd>/.outfitter — and the implementer runs
# with cwd=/work/repo (the target repo), where no such settings exist. Write a
# user-scope settings file with an absolute profile source so the profile
# resolves regardless of cwd, without moving the agent off /work/repo.
mkdir -p "$HOME/.outfitter"
cat > "$HOME/.outfitter/settings.yml" <<'FLEET_OUTFITTER_EOF'
default_profile: implementer
profile_sources:
  - path: /work/pi-fleet/profiles
FLEET_OUTFITTER_EOF

# Profile.yml declares extensions as \`../extensions/<x>\` (siblings of the
# profiles dir). Outfitter resolves skills against the profile source dir, but
# passes extension paths through to pi verbatim, and pi resolves them against
# its cwd — which is /work/repo (the target repo). So \`../extensions/linear.ts\`
# resolves to /work/extensions/linear.ts, not /work/pi-fleet/extensions/... .
# Symlink the pi-fleet extensions (and skills, defensively) to where that
# cwd-relative resolution lands so the profile loads regardless of cwd.
ln -sfn /work/pi-fleet/extensions /work/extensions
ln -sfn /work/pi-fleet/skills /work/skills

# auth for gh/git (token from env — never echo values)
if [ -n "\${FLEET_GITHUB_TOKEN:-}" ]; then
  export GH_TOKEN="$FLEET_GITHUB_TOKEN"
  git config --global url."https://x-access-token:\${FLEET_GITHUB_TOKEN}@github.com/".insteadOf "https://github.com/"
fi

# pi agent auth: pi uses OAuth (not an API key) for providers like openai-codex,
# so forward the local ~/.pi/agent/auth.json as base64 and materialize it here.
# Decode straight to the file (never to stdout) and lock it down to 600 so the
# token values are never echoed into the job log.
if [ -n "\${${PI_AGENT_AUTH_ENV}:-}" ]; then
  mkdir -p "$HOME/.pi/agent"
  printf '%s' "\${${PI_AGENT_AUTH_ENV}}" | base64 -d > "${PI_AGENT_AUTH_PATH}"
  chmod 600 "${PI_AGENT_AUTH_PATH}"
fi

finalize_result() {
${buildResultFinalizer()}
}

# The target is always the per-cast repo, never FLEET_REPO_URL (which is only
# the pi-fleet wrapper/profile source). Convert clone failures into a terminal,
# actionable result immediately instead of leaving the cast running until its
# timeout. The persisted error is deliberately synthesized rather than copied
# from gh/git output, so credentials can never be included in it.
clone_target() {
  set +e
  gh repo clone "$TARGET_REPO" /work/repo -- "$@"
  EXIT=$?
  set -e
  if [ "$EXIT" -ne 0 ]; then
    export EXIT TARGET_REPO_CLONE_FAILED=1
    echo "Target repository clone failed for $TARGET_REPO: ${TARGET_REPO_ACCESS_ERROR_HINT}"
    finalize_result
    echo "fleet e2b job $JOB_ID finished status=$STATUS"
    exit "$EXIT"
  fi
}

# codeAccess=branch: a nonexistent/invalid branch must fail the job immediately
# instead of falling through to pi-implementer (or worse, dying under \`set -e\`
# without ever writing result.json, which left the cast polling result.json
# until the sandbox's own timeout — see FLT-32). Mirrors clone_target: convert
# the failure into a terminal result right here.
checkout_branch() {
  set +e
  git fetch origin "$BRANCH_NAME" \\
    && (git checkout -b "$BRANCH_NAME" "origin/$BRANCH_NAME" || git checkout "$BRANCH_NAME")
  EXIT=$?
  set -e
  if [ "$EXIT" -ne 0 ]; then
    export EXIT BRANCH_CHECKOUT_FAILED=1
    echo "Branch '$BRANCH_NAME' not found in $TARGET_REPO (or not accessible with current credentials)."
    finalize_result
    echo "fleet e2b job $JOB_ID finished status=$STATUS"
    exit "$EXIT"
  fi
}

# codeAccess=clone: unpack the source archive the host already uploaded to
# ${REPO_SOURCE_ARCHIVE_PATH} (see archive.ts) instead of the sandbox itself
# cloning the target with credentials. Mirrors clone_target: convert a failed
# extraction into a terminal result right here rather than falling through.
extract_source_archive() {
  set +e
  mkdir -p /work/repo
  # \`< file\` (not \`base64 -d file\`) so this decodes identically under GNU and
  # BSD base64 (BSD's has no positional-file argument, only \`-i\`/stdin — passing
  # the path directly silently decodes nothing on macOS). pipefail is scoped to
  # this subshell so EXIT reflects either leg of the pipe failing, not just tar's
  # (which can otherwise exit 0 on truncated/empty input and mask a real failure).
  (set -o pipefail; base64 -d < ${REPO_SOURCE_ARCHIVE_PATH} | tar -xzf - -C /work/repo)
  EXIT=$?
  set -e
  rm -f ${REPO_SOURCE_ARCHIVE_PATH}
  if [ "$EXIT" -ne 0 ]; then
    export EXIT SOURCE_ARCHIVE_EXTRACT_FAILED=1
    echo "Failed to extract uploaded source archive for $TARGET_REPO"
    finalize_result
    echo "fleet e2b job $JOB_ID finished status=$STATUS"
    exit "$EXIT"
  fi
}

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

finalize_result

echo "fleet e2b job $JOB_ID finished status=$STATUS"
exit "$EXIT"
`;
}

/**
 * Emit the bash that turns a reviewer job's PR-fetch/comment outcome into
 * `$WORK/result.json` (FLT-45 — the reviewer-profile counterpart of
 * {@link buildResultFinalizer}). Unlike the implementer finalizer, there is no
 * agent-authored result.json to preserve: pi-reviewer has no write tool, so it
 * can never write one itself. Precedence: PR_FETCH_FAILED wins (nothing else
 * ran), then COMMENT_POST_FAILED (the review happened but never reached the
 * PR), then the reviewer process's own exit code.
 */
export function buildReviewerResultFinalizer(): string {
	return `WORK="\${WORK:-/work}"
RESULT="$WORK/result.json"
if [ "\${PR_FETCH_FAILED:-0}" = "1" ]; then
  STATUS=failed
elif [ "\${COMMENT_POST_FAILED:-0}" = "1" ]; then
  STATUS=failed
elif [ "\${EXIT:-1}" -eq 0 ]; then
  STATUS=succeeded
else
  STATUS=failed
fi
export STATUS RESULT
python3 - <<'PY'
import datetime, json, os

status = os.environ.get("STATUS", "failed")
exit_code = os.environ.get("EXIT", "1")
job_id = os.environ.get("JOB_ID")
pr_number_raw = os.environ.get("PR_NUMBER")
target_repo = os.environ.get("TARGET_REPO", "unknown")
verdict = os.environ.get("VERDICT") or "UNKNOWN"
review_url = os.environ.get("REVIEW_URL") or None

findings_summary = None
review_output = os.environ.get("REVIEW_OUTPUT", "")
if review_output and os.path.exists(review_output):
    try:
        with open(review_output, encoding="utf-8") as fh:
            findings_summary = fh.read().strip()[:4000] or None
    except Exception:
        findings_summary = None

read_only_evidence = []
evidence_path = os.environ.get("EVIDENCE", "")
if evidence_path and os.path.exists(evidence_path):
    try:
        with open(evidence_path, encoding="utf-8") as fh:
            read_only_evidence = [line.strip() for line in fh if line.strip()]
    except Exception:
        read_only_evidence = []

try:
    pr_number = int(pr_number_raw) if pr_number_raw is not None else None
except ValueError:
    pr_number = None

error = None
if os.environ.get("PR_FETCH_FAILED") == "1":
    error = (
        f"Failed to fetch PR #{pr_number_raw} for {target_repo}: "
        "${TARGET_REPO_ACCESS_ERROR_HINT}"
    )
elif os.environ.get("COMMENT_POST_FAILED") == "1":
    error = (
        f"Reviewer completed (verdict={verdict}) but failed to post the "
        f"comment to PR #{pr_number_raw} for {target_repo}."
    )
elif status == "failed":
    error = f"pi-reviewer exited {exit_code}"

result = {
    "jobId": job_id,
    "profile": "reviewer",
    "status": status,
    "prNumber": pr_number,
    "verdict": verdict,
    "findingsSummary": findings_summary,
    "reviewUrl": review_url,
    "readOnlyEvidence": read_only_evidence or None,
    "error": error,
    "finishedAt": datetime.datetime.now(datetime.timezone.utc).strftime(
        "%Y-%m-%dT%H:%M:%S.%fZ"
    ),
}
with open(os.environ["RESULT"], "w", encoding="utf-8") as fh:
    json.dump(result, fh, indent=2)
    fh.write("\\n")
PY
STATUS=$(python3 - <<'PY'
import json, os

fallback = os.environ.get("STATUS", "unknown")
try:
    with open(os.environ["RESULT"], encoding="utf-8") as fh:
        data = json.load(fh)
    print(data.get("status") or fallback)
except Exception:
    print(fallback)
PY
)
export STATUS`;
}

/**
 * Build the remote runner script for a reviewer-profile cast (FLT-45):
 * read-only fetch of an existing PR's metadata + diff via `gh pr
 * view`/`gh pr diff`, hand them to pi-reviewer (no write/edit/bash tools —
 * enforced by bin/pi-reviewer's --tools flag, unchanged here), then post its
 * findings as a PR comment via `gh pr comment`. Deliberately never runs a
 * code-mutating command — no clone, no checkout, no git push/commit, no `gh pr
 * merge`/`gh pr review --approve`/`--request-changes` (a formal review carries
 * merge-blocking authority a bot shouldn't hold; a comment keeps the human as
 * the actual merge decision-maker). Every gh call that touches the sandbox or
 * the remote PR is appended to $WORK/readonly-evidence.log so the terminal
 * result can prove the read-only guarantee, not just assert it.
 */
export function buildReviewerRunnerScript(job: FleetJob): string {
	const fleetRepo = resolveFleetRepoUrl();
	const fleetRef = job.fleetRef || "develop";
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

	const repo = normalizeRepoSlug(job.repo || "");
	const prNumber = Number(job.prNumber);

	return `#!/usr/bin/env bash
set -euo pipefail
export JOB_ID=${shellQuote(job.jobId)}
export TARGET_REPO=${shellQuote(repo)}
export PR_NUMBER=${shellQuote(String(prNumber))}
WORK=/work
RESULT="$WORK/result.json"
LOG="$WORK/job.log"
EVIDENCE="$WORK/readonly-evidence.log"
export REVIEW_OUTPUT="$WORK/review-output.txt"
export EVIDENCE
mkdir -p /work
: > "$EVIDENCE"
exec > >(tee -a "$LOG") 2>&1
echo "fleet e2b job $JOB_ID starting"

cat > /work/brief.md <<'FLEET_REVIEWER_PREAMBLE_EOF'
You are an INDEPENDENT, READ-ONLY reviewer of an EXISTING pull request. You have
no write/edit/bash tools and cannot modify any file or run any command. Read the
PR metadata at /work/pr-meta.json and the PR diff at /work/pr-diff.patch with
your read tool, then reply in exactly this format:
VERDICT: APPROVE
or
VERDICT: REQUEST-CHANGES
followed by your findings (blocking issues first, each with a concrete reason).
FLEET_REVIEWER_PREAMBLE_EOF

cat >> /work/brief.md <<'FLEET_BRIEF_EOF'

${job.brief}
FLEET_BRIEF_EOF

# pi-fleet pin (bin/pi-reviewer + profiles/reviewer + skills/code-review)
git clone --depth 1 --branch ${shellQuote(fleetRef)} ${shellQuote(fleetRepo)} /work/pi-fleet \\
  || git clone --depth 1 ${shellQuote(fleetRepo)} /work/pi-fleet
export PATH="/work/pi-fleet/bin:$PATH"

mkdir -p "$HOME/.outfitter"
cat > "$HOME/.outfitter/settings.yml" <<'FLEET_OUTFITTER_EOF'
default_profile: reviewer
profile_sources:
  - path: /work/pi-fleet/profiles
FLEET_OUTFITTER_EOF

ln -sfn /work/pi-fleet/extensions /work/extensions
ln -sfn /work/pi-fleet/skills /work/skills

# gh auth only — see docs/e2b-reviewer.md for token scoping guidance. The
# runner below never issues a code-mutating command regardless of what scope
# the resolved token actually carries (defense in depth, not the only guard).
if [ -n "\${FLEET_GITHUB_TOKEN:-}" ]; then
  export GH_TOKEN="$FLEET_GITHUB_TOKEN"
fi

if [ -n "\${${PI_AGENT_AUTH_ENV}:-}" ]; then
  mkdir -p "$HOME/.pi/agent"
  printf '%s' "\${${PI_AGENT_AUTH_ENV}}" | base64 -d > "${PI_AGENT_AUTH_PATH}"
  chmod 600 "${PI_AGENT_AUTH_PATH}"
fi

finalize_result() {
${buildReviewerResultFinalizer()}
}

# Read-only PR fetch: no clone, no checkout, nothing that could mutate the
# target repo. A failed fetch is a terminal result immediately, mirroring
# clone_target in the implementer runner (FLT-4/FLT-32).
fetch_pr() {
  set +e
  gh pr view "$PR_NUMBER" --repo "$TARGET_REPO" \\
    --json number,title,url,headRefName,baseRefName,author,body \\
    > /work/pr-meta.json
  EXIT=$?
  if [ "$EXIT" -eq 0 ]; then
    gh pr diff "$PR_NUMBER" --repo "$TARGET_REPO" > /work/pr-diff.patch
    EXIT=$?
  fi
  set -e
  if [ "$EXIT" -ne 0 ]; then
    export EXIT PR_FETCH_FAILED=1
    echo "Failed to fetch PR #$PR_NUMBER for $TARGET_REPO: ${TARGET_REPO_ACCESS_ERROR_HINT}"
    finalize_result
    echo "fleet e2b job $JOB_ID finished status=$STATUS"
    exit "$EXIT"
  fi
  echo "gh pr view $PR_NUMBER --repo $TARGET_REPO --json ... (read-only)" >> "$EVIDENCE"
  echo "gh pr diff $PR_NUMBER --repo $TARGET_REPO (read-only)" >> "$EVIDENCE"
}
fetch_pr

# profile.yml declares extensions as \`../extensions/<x>\` (siblings of the
# profiles dir); pi resolves that relative to its own cwd, not the profile's
# location (see the symlink comment above). The other runner (implementer)
# gets this for free because it cd's into /work/repo before launching its
# worker — two path segments below /, matching /work/extensions. A reviewer
# cast has no /work/repo to cd into, so without an explicit cd here pi
# inherits the sandbox's default cwd (one segment below /), and
# \`../extensions/linear.ts\` resolves to /extensions/linear.ts — which
# doesn't exist — failing with "Failed to load extension /extensions/linear.ts".
# /work/review stands in for /work/repo as that second path segment.
mkdir -p /work/review
cd /work/review

: > "$REVIEW_OUTPUT"
if command -v pi-reviewer >/dev/null 2>&1 || [ -x /work/pi-fleet/bin/pi-reviewer ]; then
  PI_REVIEW=$(command -v pi-reviewer || echo /work/pi-fleet/bin/pi-reviewer)
  set +e
  "$PI_REVIEW"${modelFlags} -p "$(cat /work/brief.md)" | tee "$REVIEW_OUTPUT"
  EXIT=$?
  set -e
else
  echo "pi-reviewer not available in sandbox PATH — install pi + outfitter in the E2B template"
  EXIT=127
fi

VERDICT=$(grep -m1 -oE 'VERDICT:[[:space:]]*(APPROVE|REQUEST-CHANGES)' "$REVIEW_OUTPUT" | sed -E 's/VERDICT:[[:space:]]*//' || true)
[ -z "\${VERDICT:-}" ] && VERDICT=UNKNOWN
export VERDICT

# Post findings as a plain PR comment — deliberately never a formal approve/
# request-changes review, which carries merge-blocking authority a bot
# shouldn't hold on its own.
if [ "$EXIT" -eq 0 ]; then
  set +e
  REVIEW_URL=$(gh pr comment "$PR_NUMBER" --repo "$TARGET_REPO" --body-file "$REVIEW_OUTPUT")
  COMMENT_EXIT=$?
  set -e
  if [ "$COMMENT_EXIT" -ne 0 ]; then
    export COMMENT_POST_FAILED=1
    echo "Failed to post review comment to PR #$PR_NUMBER for $TARGET_REPO"
  else
    export REVIEW_URL
    echo "gh pr comment $PR_NUMBER --repo $TARGET_REPO --body-file <review findings> (comment only, no approve/request-changes authority)" >> "$EVIDENCE"
  fi
fi

export EXIT
finalize_result

echo "fleet e2b job $JOB_ID finished status=$STATUS"
exit "$EXIT"
`;
}
