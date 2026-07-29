#!/usr/bin/env bash
# FLT-54 regression guard for the dual-source AC verification rule.
#
# The verifier's canonical instructions must not drift back to Linear-only AC verification.
# This deterministic structural check verifies the repo sources that launch/guide verifier and
# gate-holder seats all carry the same high-risk requirements.
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

# Canonical tracked verifier launch sources. (Some shared workflow skills are tracked as
# symlinks to the operator's local skill store; this repo-level guard checks only versioned files
# that a pi-fleet PR can actually change.)
verifier_sources=(
	"agents/ac-verifier.md"
	"profiles/ac-verifier/profile.yml"
)

assert_dual_source_contract() {
	local file="$1" role="$2"
	assert_file_contains "$file $role collects AC from Linear description checkboxes" "$file" \
		'Linear[\s\S]*(ticket )?description[\s\S]*(markdown )?checkbox'
	assert_file_contains "$file $role collects AC from the PR body" "$file" \
		'PR body[\s\S]*(acceptance criteria|checklist|AC block)'
	assert_file_contains "$file $role fails closed when either AC source is missing" "$file" \
		'fail closed|missing[\s\S]*unreadable[\s\S]*(no detectable criteria|empty)'
	assert_file_contains "$file $role compares every AC from both sources" "$file" \
		'every (AC|acceptance[- ]criteria item|item)[\s\S]*both sources'
	assert_file_contains "$file $role verifies against the PR actual head commit" "$file" \
		"PR'?s actual head commit"
	assert_file_contains "$file $role rejects stale base-branch verification" "$file" \
		'not (origin/)?(main|develop)|stale branch'
	assert_file_contains "$file $role records the verified SHA" "$file" \
		'git rev-parse HEAD|verified SHA'
	assert_file_contains "$file $role requires tests/build or typecheck/build/docs checks" "$file" \
		'tests/build/inspection|tests/typecheck/build|tests/docs checks|real commands run against real code'
	assert_file_contains "$file $role requires changed-files inspection or no-tests rationale" "$file" \
		'changed files inspected|no-tests-needed rationale'
	assert_file_contains "$file $role requires PR-posted validation evidence" "$file" \
		'([Pp]ost|posted|POSTED)[\s\S]*(validation )?evidence[\s\S]*PR|PR[\s\S]*([Pp]ost|posted|POSTED)[\s\S]*(validation )?evidence'
	assert_file_contains "$file $role makes verifier independence explicit" "$file" \
		'never (the )?implementer[\s\S]*never (the )?project lead[\s\S]*never any\s+code-writing\s+agent|never you[\s\S]*never (the )?implementer[\s\S]*never (the )?project lead[\s\S]*never any\s+code-writing\s+agent'
}

for file in "${verifier_sources[@]}"; do
	assert_dual_source_contract "$file" "verifier source"
done

# Gate-holder sources must point leads/conductors at the same rule; handoff notes alone are not enough.
for file in "skills/project-lead/SKILL.md" "skills/conductor/SKILL.md"; do
	assert_dual_source_contract "$file" "gate-holder source"
done

assert_file_contains "profile/ac-verifier declares github-pr extension" "profiles/ac-verifier/profile.yml" \
	'../extensions/github-pr\.ts'
assert_file_contains "agent/ac-verifier declares github_pr_comment tool" "agents/ac-verifier.md" \
	'github_pr_view, github_pr_comment'
assert_file_contains "bin/pi-ac-verifier exposes github_pr_comment" "bin/pi-ac-verifier" \
	'github_pr_comment'
assert_file_contains "bin/pi-ac-verifier omits write/edit tools" "bin/pi-ac-verifier" \
	'--tools read,grep,find,ls,bash,linear_get_issue,linear_list,linear_comment,linear_update,github_pr_view,github_pr_comment'
assert_file_contains "bin/pi-ac-verifier loads constrained GitHub PR extension" "bin/pi-ac-verifier" \
	'extensions/github-pr\.ts'
assert_file_contains "bin/pi-ac-verifier loads AC verifier bash policy" "bin/pi-ac-verifier" \
	'extensions/ac-verifier-policy\.ts'
assert_file_contains "github_pr_comment is comment-only" "extensions/github-pr.ts" \
	'[Cc]omment-only[\s\S]*(does not approve|no review/merge authority|merge)'
assert_file_contains "github_pr tools validate PR selector" "extensions/github-pr.ts" \
	'function prSelector[\s\S]*startsWith\("-"\)'
if (
	cd "$DIR" && node --input-type=module <<'NODE'
import assert from "node:assert/strict";
import { evaluateAcVerifierCommand } from "./bin/lib/ac-verifier-command-policy.mjs";
assert.equal(evaluateAcVerifierCommand("gh pr view 54").allowed, true);
assert.equal(evaluateAcVerifierCommand("git status").allowed, true);
assert.equal(evaluateAcVerifierCommand("gh pr comment 54 --body evidence").allowed, false);
assert.equal(evaluateAcVerifierCommand("gh pr comment 54 --edit-last --body bad").allowed, false);
assert.equal(evaluateAcVerifierCommand("git push origin HEAD").allowed, false);
assert.equal(evaluateAcVerifierCommand("git commit -m nope").allowed, false);
assert.equal(evaluateAcVerifierCommand("gh pr merge 54").allowed, false);
assert.equal(evaluateAcVerifierCommand("gh pr review 54 --approve").allowed, false);
assert.equal(evaluateAcVerifierCommand("echo bad > file").allowed, false);
NODE
); then
	ok "AC verifier policy decisions enforce comment-only/no-push boundary"
else
	no "AC verifier policy decisions enforce comment-only/no-push boundary"
fi

assert_file_contains "evals README documents the FLT-54 structural guard" "evals/README.md" \
	'ac-verification-dual-source-structural-test\.sh'

# Avoid satisfying the ticket only in transient local handoff files. Run from the repo root
# explicitly so caller cwd cannot change the result, and derive coverage from tracked file contents
# (not filenames). git grep exits 1 for no matches, so handle that separately from scan errors.
grep_status=0
flt54_files="$(git -C "$DIR" grep -l 'FLT-54' -- . 2>/tmp/flt54-grep.err)" || grep_status=$?
if ((grep_status > 1)); then
	no "tracked FLT-54 content scan completed successfully"
	cat /tmp/flt54-grep.err
else
	ok "tracked FLT-54 content scan completed successfully"
	handoff_matches="$(printf '%s\n' "$flt54_files" | grep -E '(^|/)(handoff|tmp|notes)/|(^|/)(handoff|tmp|notes)($|\.)' || true)"
	canonical_matches="$(printf '%s\n' "$flt54_files" | grep -E '^(agents/ac-verifier\.md|profiles/ac-verifier/profile\.yml|skills/(project-lead|conductor)/SKILL\.md|bin/pi-ac-verifier|extensions/(github-pr|ac-verifier-policy)\.ts|bin/lib/ac-verifier-command-policy\.mjs|README\.md|docs/permissions\.md|evals/README\.md|evals/ac-verification-dual-source-structural-test\.sh)$' || true)"
	if [ -n "$handoff_matches" ] && [ -z "$canonical_matches" ]; then
		no "FLT-54 rule is not stored only in a local handoff/notes file"
		printf '%s\n' "$handoff_matches"
	elif [ -z "$canonical_matches" ]; then
		no "FLT-54 rule has canonical tracked-file evidence"
	else
		ok "FLT-54 rule has canonical tracked-file evidence"
		ok "FLT-54 rule is not stored only in a local handoff/notes file"
	fi
fi

echo "---"
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
