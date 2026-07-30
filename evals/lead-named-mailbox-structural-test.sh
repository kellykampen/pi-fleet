#!/usr/bin/env bash
# FLT-68 structural guard: project-lead seat name + fleet-mail mailbox =
# <workspace_name>-project-lead (must match cmux pane/tab name).
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

assert_file "fleet-lead-mailbox helper exists" "bin/lib/fleet-lead-mailbox.sh"
assert_file_contains "fleet-mail.cjs recognizes named *-project-lead" \
	"bin/lib/fleet-mail.cjs" \
	'isProjectLeadMailbox|endsWith\("-project-lead"\)'
assert_file_contains "fleet-mail.cjs exports resolveProjectLeadMailbox" \
	"bin/lib/fleet-mail.cjs" \
	'resolveProjectLeadMailbox'
assert_file_contains "pi-project-lead runtime wires lead mailbox" \
	"bin/lib/pi-project-lead-runtime.sh" \
	'fleet-lead-mailbox|fleet_resolve_lead_mailbox'
assert_file_contains "claude-project-lead wires lead mailbox" \
	"bin/claude-project-lead" \
	'fleet-lead-mailbox|fleet_resolve_lead_mailbox'
assert_file_contains "project-lead skill documents named mailbox" \
	"skills/project-lead/SKILL.md" \
	'<workspace_name>-project-lead|workspace_name>-project-lead|\*-project-lead'
assert_file_contains "agent-mail documents named lead form" \
	"docs/agent-mail.md" \
	'workspace_name>-project-lead|pi-fleet-project-lead'
assert_file_contains "fleet-mail skill documents named lead" \
	"skills/fleet-mail/SKILL.md" \
	'workspace_name>-project-lead|pi-fleet-project-lead|\*-project-lead'
assert_file_contains "conductor skill mails named leads" \
	"skills/conductor/SKILL.md" \
	'workspace_name>-project-lead|pi-fleet-project-lead|\*-project-lead'

# Live resolver smoke (bash helper)
# shellcheck source=../bin/lib/fleet-lead-mailbox.sh
. "$DIR/bin/lib/fleet-lead-mailbox.sh"
unset FLEET_LEAD_MAILBOX FLEET_MAIL_FROM FLEET_PROJECT_KEY CMUX_WORKSPACE_NAME FLEET_SEAT_NAME || true
export FLEET_PROJECT_KEY=pi-fleet
fleet_resolve_lead_mailbox
if [[ "${FLEET_LEAD_MAILBOX:-}" == "pi-fleet-project-lead" && "${FLEET_MAIL_FROM:-}" == "pi-fleet-project-lead" ]]; then
	ok "bash resolver: FLEET_PROJECT_KEY=pi-fleet → pi-fleet-project-lead"
else
	no "bash resolver: FLEET_PROJECT_KEY=pi-fleet → pi-fleet-project-lead"
	echo "  got FLEET_LEAD_MAILBOX=${FLEET_LEAD_MAILBOX:-} FLEET_MAIL_FROM=${FLEET_MAIL_FROM:-}"
fi

unset FLEET_LEAD_MAILBOX FLEET_MAIL_FROM FLEET_PROJECT_KEY CMUX_WORKSPACE_NAME FLEET_SEAT_NAME || true
export CMUX_WORKSPACE_NAME=agent-skills
fleet_resolve_lead_mailbox
if [[ "${FLEET_LEAD_MAILBOX:-}" == "agent-skills-project-lead" ]]; then
	ok "bash resolver: CMUX_WORKSPACE_NAME=agent-skills → agent-skills-project-lead"
else
	no "bash resolver: CMUX_WORKSPACE_NAME=agent-skills → agent-skills-project-lead"
	echo "  got FLEET_LEAD_MAILBOX=${FLEET_LEAD_MAILBOX:-}"
fi

# Worktree path last-resort: walk up .worktrees/<ticket> → repo basename
unset FLEET_LEAD_MAILBOX FLEET_MAIL_FROM FLEET_PROJECT_KEY CMUX_WORKSPACE_NAME FLEET_SEAT_NAME || true
export FLEET_COORDINATION_ROOT="/tmp/example-repo/.worktrees/flt-68-lead-mailbox"
fleet_resolve_lead_mailbox
if [[ "${FLEET_LEAD_MAILBOX:-}" == "example-repo-project-lead" ]]; then
	ok "bash resolver: worktree path → example-repo-project-lead"
else
	no "bash resolver: worktree path → example-repo-project-lead"
	echo "  got FLEET_LEAD_MAILBOX=${FLEET_LEAD_MAILBOX:-}"
fi
unset FLEET_COORDINATION_ROOT || true

# Node unit coverage for named topology
tmpfile="$(mktemp "${TMPDIR:-/tmp}/flt-68-fleet-mail-test.XXXXXX")"
trap 'rm -f "$tmpfile"' EXIT
if node --test "$DIR/evals/fleet-mail.test.mjs" >"$tmpfile" 2>&1; then
	ok "fleet-mail unit tests (includes FLT-68 named lead cases)"
else
	no "fleet-mail unit tests (includes FLT-68 named lead cases)"
	tail -40 "$tmpfile" || true
fi

echo
echo "lead-named-mailbox structural: $pass PASS, $fail FAIL"
if [[ "$fail" -gt 0 ]]; then
	exit 1
fi
echo "VERDICT: PASS"
