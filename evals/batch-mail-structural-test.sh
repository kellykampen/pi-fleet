#!/usr/bin/env bash
# FLT-63 structural guard: batch/append messaging + multi-harness fleet-mail.
#
# Proves decision docs, lead idle-pull policy, Codex/Claude skill paths, and CLI
# presence without re-running the full mail unit suite (see pi-fleet-mail-smoke-test).
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
assert_exec() {
	local desc="$1" file="$2"
	if [[ -x "$DIR/$file" ]]; then
		ok "$desc"
	else
		no "$desc"
		echo "  not executable: $file"
	fi
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

assert_exec "bin/fleet-mail is executable" "bin/fleet-mail"
assert_file "fleet-mail core library exists" "bin/lib/fleet-mail.cjs"
assert_file "batch-append decision doc exists" "docs/batch-append-messaging.md"
assert_file "codex fleet-mail guide exists" "docs/codex-fleet-mail.md"
assert_file "AGENTS.fleet-mail fragment exists" "docs/AGENTS.fleet-mail.md"
assert_file "installable fleet-mail skill exists" "skills/fleet-mail/SKILL.md"
assert_file "pi-messenger decision exists" "docs/pi-messenger-decision.md"
assert_file "agent-mail contract exists" "docs/agent-mail.md"

# Decision answers: Pi non-steer + recommendation
assert_file_contains "decision answers Pi deliverAs followUp/nextTurn" \
	"docs/batch-append-messaging.md" \
	'deliverAs: "followUp"|deliverAs.*"nextTurn"|followUp.*nextTurn'
assert_file_contains "decision recommends fleet-mail not pi-messenger primary" \
	"docs/batch-append-messaging.md" \
	'Ship one mail backend \+ CLI: `fleet-mail`|fleet-mail.*extend FLT-58|Custom `fleet-mail`'
assert_file_contains "decision rejects pi-messenger as primary" \
	"docs/batch-append-messaging.md" \
	'Do \*\*not\*\* adopt `npm:pi-messenger`|not adopt.*pi-messenger'
assert_file_contains "decision multi-harness same CLI" \
	"docs/batch-append-messaging.md" \
	'Pi, Codex CLI, and Claude Code|Pi.*Claude.*Codex|same.*fleet-mail'

# Lead skill: no mid-turn cmux status drip; idle/cadence pull
assert_file_contains "project-lead skill forbids mid-turn cmux status drip" \
	"skills/project-lead/SKILL.md" \
	'Do not `cmux send` mid-turn|do not thrash|never mid-turn cmux drip'
assert_file_contains "project-lead skill pulls inbox on idle/cadence" \
	"skills/project-lead/SKILL.md" \
	'idle|cadence'
assert_file_contains "project-lead skill points at fleet-mail skill" \
	"skills/project-lead/SKILL.md" \
	'fleet-mail/SKILL|skills/fleet-mail'

# Worker uplink + Claude + Codex paths
assert_file_contains "implementation skill uses fleet-mail send" \
	"skills/implementation/SKILL.md" \
	'fleet-mail send'
assert_file_contains "claude-worker prompt uses fleet-mail" \
	"skills/claude-worker/PROMPT.md" \
	'fleet-mail send'
assert_file_contains "claude-worker allows Bash(fleet-mail:*)" \
	"bin/claude-worker" \
	'Bash\(fleet-mail:\*\)'
assert_file_contains "codex guide shells out to fleet-mail" \
	"docs/codex-fleet-mail.md" \
	'fleet-mail send'
assert_file_contains "AGENTS fragment topology workers→lead only" \
	"docs/AGENTS.fleet-mail.md" \
	'project-lead only'

# Topology + replaceable status still documented
assert_file_contains "agent-mail documents replaceable STATUS slots" \
	"docs/agent-mail.md" \
	'Replaceable STATUS slots'
assert_file_contains "agent-mail documents multi-harness table" \
	"docs/agent-mail.md" \
	'Codex CLI|Claude Code'
assert_file_contains "fleet-mail skill topology workers→lead" \
	"skills/fleet-mail/SKILL.md" \
	'project-lead only'

# Core library still enforces topology string
assert_file_contains "fleet-mail.cjs topology deny message present" \
	"bin/lib/fleet-mail.cjs" \
	'may only mail project-lead'

echo
echo "batch-mail structural: $pass PASS, $fail FAIL"
if [[ "$fail" -gt 0 ]]; then
	exit 1
fi
echo "VERDICT: PASS"
