/**
 * pi-fleet E2B extension — secret handling.
 *
 * GitHub tokens, model keys, and the E2B API key are only ever passed through
 * environment variables. They are never embedded in generated scripts and never
 * persisted or logged by this extension. Remote output is sanitized before it
 * is stored in the local job record.
 */
import type { FleetJob } from "./types.js";

// Repo the E2B worker clones. No hardcoded default — set FLEET_REPO_URL in your env.
const FLEET_REPO_DEFAULT = process.env.FLEET_REPO_URL?.trim() || "";

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

/** All env keys that may hold sensitive values; used for log sanitization. */
export const SENSITIVE_ENV_KEYS = [
	...GITHUB_TOKEN_ENV_KEYS,
	"E2B_API_KEY",
	...FLEET_WORKER_MODEL_KEYS,
];

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

/** Build the remote runner script (secrets only via env — never embedded). */
export function buildRunnerScript(job: FleetJob): string {
	const fleetRepo = FLEET_REPO_DEFAULT;
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
	const repo = job.repo || "";
	if (job.codeAccess === "pr") {
		checkout = [
			`gh repo clone ${shellQuote(repo)} /work/repo -- --depth 1`,
			"cd /work/repo",
			`gh pr checkout ${Number(job.prNumber)}`,
		].join("\n");
	} else if (job.codeAccess === "branch") {
		checkout = [
			`gh repo clone ${shellQuote(repo)} /work/repo -- --depth 1 --branch ${shellQuote(job.branch || "")}`,
			"cd /work/repo",
		].join("\n");
	} else {
		const newBranch = job.branch || `fleet/${job.jobId.slice(0, 8)}`;
		checkout = [
			`gh repo clone ${shellQuote(repo)} /work/repo -- --depth 1 --branch ${shellQuote(baseBranch)}`,
			"cd /work/repo",
			`git checkout -b ${shellQuote(newBranch)}`,
		].join("\n");
	}

	return `#!/usr/bin/env bash
set -euo pipefail
export JOB_ID=${shellQuote(job.jobId)}
RESULT=/work/result.json
LOG=/work/job.log
mkdir -p /work
exec > >(tee -a "$LOG") 2>&1
echo "fleet e2b job $JOB_ID starting"

cat > /work/brief.md <<'FLEET_BRIEF_EOF'
${job.brief}
FLEET_BRIEF_EOF

# pi-fleet pin
git clone --depth 1 --branch ${shellQuote(fleetRef)} ${shellQuote(fleetRepo)} /work/pi-fleet \\
  || git clone --depth 1 ${shellQuote(fleetRepo)} /work/pi-fleet
export PATH="/work/pi-fleet/bin:$PATH"

# auth for gh/git (token from env — never echo values)
if [ -n "\${FLEET_GITHUB_TOKEN:-}" ]; then
  export GH_TOKEN="\$FLEET_GITHUB_TOKEN"
  git config --global url."https://x-access-token:\${FLEET_GITHUB_TOKEN}@github.com/".insteadOf "https://github.com/"
fi

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
if [ "$EXIT" -eq 0 ]; then export STATUS=succeeded; else export STATUS=failed; fi

if [ ! -f "$RESULT" ]; then
  python3 - <<'PY'
import json, os, datetime
status = os.environ.get("STATUS", "failed")
exit_code = os.environ.get("EXIT", "1")
result = {
  "jobId": os.environ.get("JOB_ID"),
  "profile": "implementer",
  "status": status,
  "commitSha": os.environ.get("SHA") or None,
  "prUrl": os.environ.get("PR_URL") or None,
  "branch": os.environ.get("BRANCH") or None,
  "error": None if status == "succeeded" else f"pi-implementer exited {exit_code}",
  "finishedAt": datetime.datetime.utcnow().isoformat() + "Z",
}
with open("/work/result.json", "w", encoding="utf-8") as f:
  json.dump(result, f, indent=2)
  f.write("\\n")
PY
fi

echo "fleet e2b job $JOB_ID finished status=$STATUS"
exit "$EXIT"
`;
}
