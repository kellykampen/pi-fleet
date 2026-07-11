/**
 * pi-fleet E2B extension — secret handling.
 *
 * GitHub tokens, model keys, and the E2B API key are only ever passed through
 * environment variables. They are never embedded in generated scripts and never
 * persisted or logged by this extension. Remote output is sanitized before it
 * is stored in the local job record.
 */
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

/** All env keys that may hold sensitive values; used for log sanitization. */
export const SENSITIVE_ENV_KEYS = [
	...GITHUB_TOKEN_ENV_KEYS,
	"E2B_API_KEY",
	PI_AGENT_AUTH_ENV,
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

/** Collect the secrets that should be injected into the E2B sandbox env. */
export function collectWorkerEnv(): Record<string, string> {
	const envs: Record<string, string> = {};
	const gh = resolveGithubToken();
	if (gh) envs.FLEET_GITHUB_TOKEN = gh;
	for (const key of FLEET_WORKER_MODEL_KEYS) {
		const v = process.env[key]?.trim();
		if (v) envs[key] = v;
	}
	const piAuth = process.env[PI_AGENT_AUTH_ENV]?.trim();
	if (piAuth) envs[PI_AGENT_AUTH_ENV] = piAuth;
	return envs;
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
		.replace(/gho_[A-Za-z0-9]{30,}/g, "***");

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
	const baseBranch = job.baseBranch || "main";
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
			`git fetch origin ${shellQuote(branch)}`,
			`git checkout -b ${shellQuote(branch)} origin/${shellQuote(branch)} || git checkout ${shellQuote(branch)}`,
		].join("\n");
	} else {
		const newBranch = job.branch || `fleet/${job.jobId.slice(0, 8)}`;
		checkout = [
			`clone_target --depth 1 --branch ${shellQuote(baseBranch)}`,
			"cd /work/repo",
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
