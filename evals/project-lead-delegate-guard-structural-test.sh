#!/usr/bin/env bash
# Deterministic structural guard: pi-project-lead is coordination-only / non-bottleneck in both prose and harness.
#
# Proves (FLT-67: no permission-system; always YOLO):
# 1) wrapper --tools omits write/edit and keeps coordination/E2B tools
# 2) wrapper loads isolated runtime + project-lead-policy (NOT pi-permission-system)
# 3) seat "lead" command policy allows coordination and denies implementation/review shell
# 4) role prose forbids self-implementation / light-work absorption
# 5) FLT-62 non-bottleneck phrases: bottleneck forbidden, cast immediately, poll cadence,
#    parallel seats, silence-while-agents-run failure, no light product work, mid-turn cmux-send ban
# 6) always --approve; no PS package/config paths
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

pass=0
fail=0
ok() {
	echo "PASS: $1"
	pass=$((pass + 1))
}
no() {
	echo "FAIL: $1"
	fail=$((fail + 1))
}
assert_file_contains() {
	local desc="$1" file="$2" pattern="$3"
	if python3 - "$DIR/$file" "$pattern" <<'PY'; then
import re
import sys
path, pattern = sys.argv[1], sys.argv[2]
text = open(path, encoding="utf-8").read()
sys.exit(0 if re.search(pattern, text, re.MULTILINE | re.DOTALL) else 1)
PY
		ok "$desc"
	else
		no "$desc"
		echo "  missing pattern: $pattern"
		echo "  in: $file"
	fi
}
assert_file_lacks() {
	local desc="$1" file="$2" pattern="$3"
	if python3 - "$DIR/$file" "$pattern" <<'PY'; then
import re
import sys
path, pattern = sys.argv[1], sys.argv[2]
text = open(path, encoding="utf-8").read()
sys.exit(0 if not re.search(pattern, text, re.MULTILINE | re.DOTALL) else 1)
PY
		ok "$desc"
	else
		no "$desc"
		echo "  unexpectedly found pattern: $pattern"
		echo "  in: $file"
	fi
}

WRAPPER="$DIR/bin/pi-project-lead"
tools_line="$(grep -E -- '--tools ' "$WRAPPER" | tail -1)"

if printf '%s\n' "$tools_line" | grep -Eq -- '--tools read,grep,find,ls,bash,linear_get_issue,linear_list,linear_comment,linear_update,e2b_cast,e2b_status,e2b_wait,e2b_cancel,e2b_logs,e2b_port_url'; then
	ok "pi-project-lead --tools is coordination-only (no write/edit)"
else
	no "pi-project-lead --tools is coordination-only (no write/edit)"
	echo "  tools line: $tools_line"
fi
if printf '%s\n' "$tools_line" | grep -Eq 'write|edit'; then
	no "pi-project-lead tools line still names write or edit"
else
	ok "pi-project-lead tools line still omits write/edit tokens"
fi
if printf '%s\n' "$tools_line" | grep -Eq 'e2b_cast|e2b_status|e2b_wait|e2b_cancel|e2b_logs|e2b_port_url'; then
	ok "pi-project-lead keeps E2B cast tools"
else
	no "pi-project-lead keeps E2B cast tools"
fi
if printf '%s\n' "$tools_line" | grep -Eq ',bash,|,bash$'; then
	ok "pi-project-lead keeps bash for casting/coordination"
else
	no "pi-project-lead keeps bash for casting/coordination"
fi

assert_file_contains "wrapper sources isolated project-lead runtime" \
	"bin/pi-project-lead" \
	'pi-project-lead-runtime\.sh'
assert_file_contains "wrapper prepares isolated runtime before launch" \
	"bin/pi-project-lead" \
	'pi_project_lead_prepare_runtime'
assert_file_contains "wrapper loads project-lead-policy extension" \
	"bin/pi-project-lead" \
	'extensions/project-lead-policy\.ts'
assert_file_contains "project-lead-policy evaluates seat lead" \
	"extensions/project-lead-policy.ts" \
	'seat:\s*"lead"'
assert_file_contains "wrapper always passes --approve (always YOLO)" \
	"bin/pi-project-lead" \
	'--approve'
assert_file_lacks "wrapper does not load PI_PERMISSION_SYSTEM_PATH assignment" \
	"bin/pi-project-lead" \
	'export PI_PERMISSION_SYSTEM_PATH|PI_PERMISSION_SYSTEM_PATH='
assert_file_lacks "wrapper does not load PS as --extension" \
	"bin/pi-project-lead" \
	'--extension.*@gotgenes/pi-permission-system|npm/node_modules/@gotgenes/pi-permission-system'
if [ ! -e "$DIR/permission-system" ]; then
	ok "permission-system/ directory is removed from repo"
else
	no "permission-system/ directory is removed from repo"
fi
# Runtime must not require the package (operational wiring; comments may mention removal).
assert_file_lacks "runtime does not resolve npm pi-permission-system package" \
	"bin/lib/pi-project-lead-runtime.sh" \
	'npm/node_modules/@gotgenes/pi-permission-system|export PI_PERMISSION_SYSTEM_PATH|PI_PERMISSION_SYSTEM_PATH='

# Shared command-policy unit surface already used by Claude lead + Pi conductor.
POLICY_JS="$DIR/evals/.tmp-project-lead-policy-check.mjs"
cat >"$POLICY_JS" <<'JS'
import assert from "node:assert/strict";
import { evaluateCommand } from "../bin/lib/conductor-command-policy.mjs";

const allow = (command) =>
	assert.equal(evaluateCommand(command, { seat: "lead", cwd: "/repo" }).allowed, true, command);
const deny = (command) =>
	assert.equal(evaluateCommand(command, { seat: "lead", cwd: "/repo" }).allowed, false, command);

for (const command of [
	"cmux new-pane --workspace ${CMUX_WORKSPACE_ID} --type terminal --direction right",
	'cmux send --workspace "${CMUX_WORKSPACE_ID}" --surface surface:1 "cd /repo && pi-implementer"',
	"cmux capture-pane --workspace ${CMUX_WORKSPACE_ID} --surface surface:1",
	"gh pr view 42",
	"gh pr list --state open",
	"gh pr checks 42",
	"gh pr merge 42 --merge",
	"gh pr comment 42 --body gate-passed",
	"git status --short",
	"git fetch origin",
	"git pull --ff-only origin main",
	"git checkout main",
	"git push origin main",
	"git worktree add .worktrees/flt-1 -b flt-1 main",
	"uptime",
	"fleet-note append coordination/status.md ok",
	"fleet-mail inbox --mailbox project-lead --unread",
	"linear-cli issue get FLT-1",
]) allow(command);

for (const command of [
	"git commit -am implementation",
	"git clone https://example.invalid/repo.git",
	"gh pr create --title t --body b",
	"gh pr review 42 --approve",
	"pnpm test",
	"pnpm check:all",
	"npm ci",
	"node build.js",
	"python3 script.py",
	"bash script.sh",
	"sed -i '' s/a/b/ source.ts",
	"tee source.ts",
]) deny(command);

console.log("policy-unit-checks-ok");
JS
if node "$POLICY_JS" >/dev/null; then
	ok "seat lead command policy allows coordination and denies implementation/review shell"
else
	no "seat lead command policy allows coordination and denies implementation/review shell"
	node "$POLICY_JS" || true
fi
rm -f "$POLICY_JS"

# Prose: non-bottleneck / cast immediately / no light product work (FLT-62 + delegate-only).
assert_file_contains "skill names Non-bottleneck rule (FLT-62)" \
	"skills/project-lead/SKILL.md" \
	'Non-bottleneck rule \(FLT-62\)'
assert_file_contains "skill states bottleneck forbidden" \
	"skills/project-lead/SKILL.md" \
	'Bottleneck forbidden|Bottleneck behavior is forbidden'
assert_file_contains "skill forbids self-implementation including light fixes" \
	"skills/project-lead/SKILL.md" \
	'do not implement, review, AC-verify, docs-pass, or "just do a light'
assert_file_contains "skill states no light product work" \
	"skills/project-lead/SKILL.md" \
	'No light product work'
assert_file_contains "skill says cast immediately" \
	"skills/project-lead/SKILL.md" \
	'Cast immediately'
assert_file_contains "skill says cast immediately is non-negotiable" \
	"skills/project-lead/SKILL.md" \
	'Non-negotiable: cast, do not self-serve'
assert_file_contains "skill requires poll every 2-5 minutes" \
	"skills/project-lead/SKILL.md" \
	'Poll every 2[–-]5 minutes'
assert_file_contains "skill requires parallel seats mandatory" \
	"skills/project-lead/SKILL.md" \
	'[Pp]arallel seats mandatory'
assert_file_contains "skill states silence while agents run is a process failure" \
	"skills/project-lead/SKILL.md" \
	'[Ss]ilence while agents run is a process failure'
assert_file_contains "skill forbids being critical path for code changes" \
	"skills/project-lead/SKILL.md" \
	'Never the critical path for code changes|never the critical path for code changes'
assert_file_contains "skill requires compressed rollups" \
	"skills/project-lead/SKILL.md" \
	'[Cc]ompressed rollups'
assert_file_contains "skill aligns harness no write/edit / delegate-only" \
	"skills/project-lead/SKILL.md" \
	'no `write`/`edit` tools \(delegate-only boundary\)|Harness align: no write/edit|no write/edit.*delegate-only'
assert_file_contains "skill forbids mid-turn cmux send while Working" \
	"skills/project-lead/SKILL.md" \
	'Do NOT.*cmux send.*mid-turn|Do not mid-turn interrupt a Working worker'
assert_file_contains "skill allows batch handoff file or one idle message" \
	"skills/project-lead/SKILL.md" \
	'Batch handoff file[\s\S]*One idle message|batch handoff file or one idle message'
assert_file_contains "skill cross-links communication topology" \
	"skills/project-lead/SKILL.md" \
	'Communication topology \(FLT-57\)'
assert_file_lacks "skill no longer offers docs pass yourself exception" \
	"skills/project-lead/SKILL.md" \
	'do it yourself for small/docs-adjacent'
assert_file_contains "agent frontmatter tools omit write/edit" \
	"agents/project-lead.md" \
	'^tools: read, grep, find, ls, bash$'
assert_file_contains "agent prose states bottleneck forbidden" \
	"agents/project-lead.md" \
	'Bottleneck forbidden'
assert_file_contains "agent prose forbids light self-work" \
	"agents/project-lead.md" \
	'do not implement, review, AC-verify, docs-pass, or "just fix a'
assert_file_contains "agent prose states no light product work" \
	"agents/project-lead.md" \
	'No light product work|no light product work'
assert_file_contains "agent prose says cast immediately + poll cadence" \
	"agents/project-lead.md" \
	'Cast immediately[\s\S]*Poll every 2[–-]5 minutes|cast immediately; poll every 2[–-]5 minutes'
assert_file_contains "agent prose states silence while agents run is a process failure" \
	"agents/project-lead.md" \
	'[Ss]ilence while agents run is a process failure'
assert_file_contains "agent prose forbids mid-turn cmux-send when Working" \
	"agents/project-lead.md" \
	'Do NOT cmux-send mid-turn when a worker is\s*Working|batch handoff file or one idle message'
assert_file_contains "profile append prompt forbids self-implementation" \
	"profiles/project-lead/profile.yml" \
	'Never implement, review, AC-verify, or docs-pass in your own session'
assert_file_contains "profile states bottleneck forbidden" \
	"profiles/project-lead/profile.yml" \
	'Bottleneck forbidden'
assert_file_contains "profile states cast immediately + poll cadence" \
	"profiles/project-lead/profile.yml" \
	'Cast immediately[\s\S]*poll every\s+2[–-]5 minutes|cast immediately;\s*parallel seats mandatory;\s*poll every\s+2[–-]5 minutes'
assert_file_contains "profile states silence while agents run is a process failure" \
	"profiles/project-lead/profile.yml" \
	'silence while agents run is a process failure'
assert_file_contains "profile states no light product work" \
	"profiles/project-lead/profile.yml" \
	'no light product work'
assert_file_contains "profile forbids mid-turn cmux-send when Working" \
	"profiles/project-lead/profile.yml" \
	'Do NOT cmux-send mid-turn when a worker is Working|batch handoff file or one idle message'
assert_file_contains "profile aligns harness no write/edit" \
	"profiles/project-lead/profile.yml" \
	'no write/edit tools \(delegate-only boundary\)|Harness align: no write/edit'
assert_file_contains "README documents no write/edit for pi-project-lead" \
	"README.md" \
	'pi-project-lead.*no write/edit'
assert_file_contains "docs/permissions documents project-lead structural boundary" \
	"docs/permissions.md" \
	'project-lead'
assert_file_contains "seat tool-boundary matrix expects project-lead without write/edit" \
	"bin/pi-fleet-eval" \
	'project-lead:Y:N:N'
assert_file_contains "evals README matrix places project-lead with conductor" \
	"evals/README.md" \
	'conductor, project-lead, ac-verifier'
assert_file_contains "evals README documents FLT-62 non-bottleneck phrases" \
	"evals/README.md" \
	'bottleneck forbidden|Non-bottleneck rule \(FLT-62\)|silence while agents run is a process failure'

echo "---"
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
