#!/usr/bin/env bash
# Structural guard: fleet-mail is the DEFAULT fleet communication channel.
#
# Codifies conductor ask ms7pb84d on top of FLT-68 (named mailbox / PR #75):
# - agent-to-agent via fleet-mail, not cmux (except launch/bootstrap/emergency)
# - mailbox == cmux pane/tab name
# - leads = <workspace>-project-lead
# - poll on startup / task-boundary / 5-10 min / before blocked-done
# - topology worker → lead → conductor
# - GPT usage guard + pre-merge AC still present (no regression)
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
assert_file() {
	local desc="$1" file="$2"
	if [[ -f "$DIR/$file" ]]; then
		ok "$desc"
	else
		no "$desc"
		echo "  missing file: $file"
	fi
}
assert_file_contains() {
	local desc="$1" file="$2" pattern="$3"
	if python3 - "$DIR/$file" "$pattern" <<'PY'
import re
import sys
path, pattern = sys.argv[1], sys.argv[2]
text = open(path, encoding="utf-8").read()
sys.exit(0 if re.search(pattern, text, re.MULTILINE | re.DOTALL) else 1)
PY
	then
		ok "$desc"
	else
		no "$desc"
		echo "  missing pattern: $pattern"
		echo "  in: $file"
	fi
}

assert_file "agent-mail contract exists" "docs/agent-mail.md"
assert_file "fleet-mail skill exists" "skills/fleet-mail/SKILL.md"

# --- DEFAULT channel ---
assert_file_contains "agent-mail declares fleet-mail DEFAULT channel" \
	"docs/agent-mail.md" \
	'DEFAULT fleet communication|fleet-mail is the DEFAULT|DEFAULT.*fleet-mail'
assert_file_contains "agent-mail restricts cmux to launch/bootstrap/emergency" \
	"docs/agent-mail.md" \
	'launch.*bootstrap.*emergency|except.*launch|bootstrap.*emergency'
assert_file_contains "fleet-mail skill declares DEFAULT channel" \
	"skills/fleet-mail/SKILL.md" \
	'DEFAULT fleet communication|fleet-mail is the DEFAULT|DEFAULT.*agent-to-agent'
assert_file_contains "fleet-mail skill restricts cmux exceptions" \
	"skills/fleet-mail/SKILL.md" \
	'launch.*bootstrap.*emergency|except.*launch|bootstrap.*emergency'

# --- mailbox == pane name + named lead (coordinate with FLT-68, do not weaken) ---
assert_file_contains "agent-mail: mailbox equals pane/tab name" \
	"docs/agent-mail.md" \
	'mailbox.*pane|pane/tab name|cmux pane/tab'
assert_file_contains "agent-mail: leads are <workspace>-project-lead" \
	"docs/agent-mail.md" \
	'workspace_name>-project-lead|workspace>-project-lead'
assert_file_contains "project-lead skill: named lead mailbox" \
	"skills/project-lead/SKILL.md" \
	'workspace_name>-project-lead|workspace>-project-lead'

# --- Poll cadence (startup / task-boundary / 5-10 min / before blocked-done) ---
assert_file_contains "agent-mail documents poll cadence" \
	"docs/agent-mail.md" \
	'startup|task[- ]boundary|5[–-]10'
assert_file_contains "agent-mail poll includes startup" \
	"docs/agent-mail.md" \
	'[Pp]oll[\s\S]{0,200}startup|startup[\s\S]{0,200}[Pp]oll|on startup'
assert_file_contains "agent-mail poll includes task boundary" \
	"docs/agent-mail.md" \
	'task[- ]boundary|task boundary'
assert_file_contains "agent-mail poll includes 5-10 min" \
	"docs/agent-mail.md" \
	'5[–-]10\s*min'
assert_file_contains "agent-mail poll includes before blocked/done" \
	"docs/agent-mail.md" \
	'before (reporting )?(blocked|done)|blocked.?done|before blocked'
assert_file_contains "fleet-mail skill documents poll cadence" \
	"skills/fleet-mail/SKILL.md" \
	'startup|task[- ]boundary|5[–-]10'
assert_file_contains "project-lead skill poll cadence for fleet-mail" \
	"skills/project-lead/SKILL.md" \
	'fleet-mail[\s\S]{0,400}(startup|task[- ]boundary|5[–-]10)|(startup|task[- ]boundary|5[–-]10)[\s\S]{0,400}fleet-mail|Poll fleet-mail|poll.*inbox'
assert_file_contains "conductor skill poll cadence for fleet-mail" \
	"skills/conductor/SKILL.md" \
	'fleet-mail[\s\S]{0,400}(startup|cadence|5[–-]10)|(startup|cadence|5[–-]10)[\s\S]{0,400}fleet-mail|inbox --mailbox conductor'

# --- Topology worker → lead → conductor ---
assert_file_contains "agent-mail topology worker→lead only" \
	"docs/agent-mail.md" \
	'project-lead only|worker.*project-lead'
assert_file_contains "agent-mail topology lead→conductor rollups" \
	"docs/agent-mail.md" \
	'conductor.*compact|compact rollups|to `conductor`|to conductor'
assert_file_contains "implementation skill mails lead only via fleet-mail" \
	"skills/implementation/SKILL.md" \
	'fleet-mail send[\s\S]*project-lead|project lead only.*fleet-mail|fleet-mail.*project lead only'
assert_file_contains "conductor rejects worker mail path" \
	"skills/conductor/SKILL.md" \
	'do not accept worker|never accept.*worker|rejects.*worker|worker.*conductor'

# --- Profiles / agents surface DEFAULT channel ---
assert_file_contains "project-lead profile surfaces fleet-mail default" \
	"profiles/project-lead/profile.yml" \
	'fleet-mail|DEFAULT fleet|mailbox'
assert_file_contains "conductor profile surfaces fleet-mail" \
	"profiles/conductor/profile.yml" \
	'fleet-mail'
assert_file_contains "implementer profile or skill uses fleet-mail" \
	"skills/implementation/SKILL.md" \
	'fleet-mail'
assert_file_contains "agents/project-lead surfaces fleet-mail poll/default" \
	"agents/project-lead.md" \
	'fleet-mail'
assert_file_contains "agents/conductor surfaces fleet-mail" \
	"agents/conductor.md" \
	'fleet-mail'
assert_file_contains "agents/implementer surfaces fleet-mail" \
	"agents/implementer.md" \
	'fleet-mail'

# --- GPT guard + pre-merge AC preserved (no regression while baking mail default) ---
assert_file_contains "project-lead skill preserves GPT usage guard" \
	"skills/project-lead/SKILL.md" \
	'GPT usage guard|FLT-55'
assert_file_contains "conductor skill preserves GPT usage guard" \
	"skills/conductor/SKILL.md" \
	'GPT usage guard|FLT-55'
assert_file_contains "project-lead skill preserves pre-merge AC" \
	"skills/project-lead/SKILL.md" \
	'PRE-merge|pre-merge'
assert_file_contains "conductor skill preserves pre-merge AC" \
	"skills/conductor/SKILL.md" \
	'PRE-MERGE|pre-merge|PRE-merge'
assert_file_contains "project-lead skill preserves no lead merge unless CEO orders" \
	"skills/project-lead/SKILL.md" \
	'no lead merge unless the CEO orders|Merge to main only when the CEO orders'
assert_file_contains "conductor skill preserves no lead merge unless CEO orders" \
	"skills/conductor/SKILL.md" \
	'no lead merge unless the CEO orders|merges to main only when the CEO orders'

# Multi-harness still covered
assert_file_contains "claude-worker uses fleet-mail" \
	"skills/claude-worker/PROMPT.md" \
	'fleet-mail'
assert_file_contains "AGENTS fragment documents DEFAULT or fleet-mail" \
	"docs/AGENTS.fleet-mail.md" \
	'fleet-mail|DEFAULT'

# Eval README documents this guard
assert_file_contains "evals/README.md documents fleet-mail-default structural guard" \
	"evals/README.md" \
	'fleet-mail-default-structural-test\.sh'

echo
echo "fleet-mail-default structural: $pass PASS, $fail FAIL"
if [[ "$fail" -gt 0 ]]; then
	exit 1
fi
echo "VERDICT: PASS"
