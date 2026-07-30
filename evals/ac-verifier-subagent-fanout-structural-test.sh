#!/usr/bin/env bash
# FLT-56 regression guard: pi-ac-verifier fans out one verify-only subagent per AC criterion.
#
# Deterministic structural check that the parent seat retains the subagent tool + pi-subagents
# machinery, that a dedicated ac-criterion-verifier child exists as verify-only, and that
# parent instructions document the full dual-source → fanout → synthesize → evidence loop.
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
		echo "  unexpected pattern: $pattern"
		echo "  in: $file"
	fi
}

# --- Parent retains dual-source + fanout capability ---
for file in "agents/ac-verifier.md" "profiles/ac-verifier/profile.yml"; do
	assert_file_contains "$file parent still dual-sources Linear + PR AC" "$file" \
		'BOTH canonical sources|Collect AC from BOTH'
	assert_file_contains "$file parent fans out one child per criterion" "$file" \
		'one (verify-only )?child per criterion|spawn a distinct.*ac-criterion-verifier|for each unchecked'
	assert_file_contains "$file parent synthesizes before marking complete" "$file" \
		'[Ss]ynthesiz'
	assert_file_contains "$file parent posts dual-source PR + Linear evidence" "$file" \
		'github_pr_comment[\s\S]*linear_comment|linear_comment[\s\S]*github_pr_comment'
	assert_file_contains "$file parent checks only PASSed criteria" "$file" \
		'check only (criteria|real PASSes)|Check only real PASS|only criteria that actually PASS'
	assert_file_contains "$file parent keeps hard rules (head / no self-tick / no merge)" "$file" \
		"PR'?s actual head commit[\s\S]*(never|do not) merge|do not merge[\s\S]*head"
done

assert_file_contains "agent/ac-verifier declares subagent tool" "agents/ac-verifier.md" \
	'tools:.*\bsubagent\b'
assert_file_contains "bin/pi-ac-verifier exposes subagent tool" "bin/pi-ac-verifier" \
	'--tools read,grep,find,ls,bash,subagent,linear_get_issue,linear_list,linear_comment,linear_update,github_pr_view,github_pr_comment'
assert_file_contains "bin/pi-ac-verifier loads pi-subagents extension" "bin/pi-ac-verifier" \
	'pi-subagents|PI_SUBAGENTS_PATH'
assert_file_contains "bin/pi-ac-verifier still omits write/edit" "bin/pi-ac-verifier" \
	'--tools read,grep,find,ls,bash,subagent,'
assert_file_lacks "bin/pi-ac-verifier does not grant write tool" "bin/pi-ac-verifier" \
	'--tools[^"\n]*\bwrite\b'
assert_file_lacks "bin/pi-ac-verifier does not grant edit tool" "bin/pi-ac-verifier" \
	'--tools[^"\n]*\bedit\b'
assert_file_contains "bin/pi-ac-verifier still loads AC verifier bash policy" "bin/pi-ac-verifier" \
	'extensions/ac-verifier-policy\.ts'
assert_file_contains "bin/pi-ac-verifier still loads github-pr extension" "bin/pi-ac-verifier" \
	'extensions/github-pr\.ts'
assert_file_lacks "profile/ac-verifier does not double-load extensions" "profiles/ac-verifier/profile.yml" \
	'^[[:space:]]*extensions:'
assert_file_contains "profile documents concurrent fanout via tasks" "profiles/ac-verifier/profile.yml" \
	'tasks:.*ac-criterion-verifier|concurrent fanout|Independent criteria fan out concurrently'
assert_file_contains "agent documents concurrent fanout via tasks" "agents/ac-verifier.md" \
	'tasks: \[|fan out concurrently|Independent criteria fan out concurrently'

# --- Child is verify-only / single-criterion ---
assert_file_contains "child agent roster entry exists" "agents/ac-criterion-verifier.md" \
	'name: ac-criterion-verifier'
assert_file_contains "child tools are verify-only (bash+read, no write/edit/subagent/linear/github)" "agents/ac-criterion-verifier.md" \
	'tools: read, grep, find, ls, bash'
assert_file_lacks "child does not declare write" "agents/ac-criterion-verifier.md" \
	'tools:[^\n]*\bwrite\b'
assert_file_lacks "child does not declare edit" "agents/ac-criterion-verifier.md" \
	'tools:[^\n]*\bedit\b'
assert_file_lacks "child does not declare subagent (no nested fanout)" "agents/ac-criterion-verifier.md" \
	'tools:[^\n]*\bsubagent\b'
assert_file_lacks "child does not declare linear_update" "agents/ac-criterion-verifier.md" \
	'tools:[^\n]*linear_update'
assert_file_lacks "child does not declare github_pr_comment" "agents/ac-criterion-verifier.md" \
	'tools:[^\n]*github_pr_comment'
assert_file_contains "child must not tick boxes / edit / merge" "agents/ac-criterion-verifier.md" \
	'(must not|MUST NOT|never).*(tick|check).*(box|boxes)|never ticks boxes'
assert_file_contains "child returns structured PASS/FAIL evidence" "agents/ac-criterion-verifier.md" \
	'"status":\s*"PASS"\s*\|\s*"FAIL"|status.*PASS.*FAIL'
assert_file_contains "child returns evidence[] and blockers[]" "agents/ac-criterion-verifier.md" \
	'evidence[\s\S]*blockers|"evidence"[\s\S]*"blockers"'
assert_file_contains "child verifies single criterion against PR head" "agents/ac-criterion-verifier.md" \
	'exactly one[\s\S]*criterion|one acceptance criterion[\s\S]*PR'
assert_file_contains "child completionGuard disabled (bash validator)" "agents/ac-criterion-verifier.md" \
	'completionGuard:\s*false'

# --- Seat matrix / eval wiring expects child boundary ---
assert_file_contains "subagent tools eval includes ac-criterion-verifier as bash-only" "bin/pi-fleet-eval-subagents" \
	'ac-criterion-verifier:Y:N:N'
assert_file_contains "evals README documents FLT-56 fanout structural guard" "evals/README.md" \
	'ac-verifier-subagent-fanout-structural-test\.sh|FLT-56'

# --- Canonical tracked evidence is not only handoff notes ---
grep_status=0
flt56_files="$(git -C "$DIR" grep -l 'FLT-56' -- . 2>/tmp/flt56-grep.err)" || grep_status=$?
if ((grep_status > 1)); then
	no "tracked FLT-56 content scan completed successfully"
	cat /tmp/flt56-grep.err
else
	ok "tracked FLT-56 content scan completed successfully"
	canonical_matches="$(printf '%s\n' "$flt56_files" | grep -E '^(agents/ac-verifier\.md|agents/ac-criterion-verifier\.md|profiles/ac-verifier/profile\.yml|bin/pi-ac-verifier|evals/README\.md|evals/ac-verifier-subagent-fanout-structural-test\.sh|evals/ac-verification-dual-source-structural-test\.sh|docs/permissions\.md|README\.md)$' || true)"
	if [ -z "$canonical_matches" ]; then
		no "FLT-56 rule has canonical tracked-file evidence"
	else
		ok "FLT-56 rule has canonical tracked-file evidence"
	fi
fi

echo "---"
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
