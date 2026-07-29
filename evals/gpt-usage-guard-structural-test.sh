#!/usr/bin/env bash
# FLT-55 regression guard for the GPT usage guard model-routing override.
#
# Ensures the active guard is codified in canonical source-of-truth files, not only
# in scratch handoff notes, and that exact non-GPT invocation examples are present.
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

# Core guard statement in the project-lead and conductor skills.
assert_file_contains "skills/project-lead/SKILL.md blocks new GPT/OpenAI worker casts" \
	"skills/project-lead/SKILL.md" \
	'new GPT/OpenAI worker casts are blocked unless explicitly CEO/conductor-approved'
assert_file_contains "skills/conductor/SKILL.md blocks new GPT/OpenAI worker casts" \
	"skills/conductor/SKILL.md" \
	'new GPT/OpenAI worker casts are blocked unless explicitly CEO/conductor-approved'

# Exact preferred non-GPT invocation examples.
assert_file_contains "docs/model-overrides.md provides Grok example" \
	"docs/model-overrides.md" \
	'--provider xai-auth --model grok-4\.5-latest'
assert_file_contains "docs/model-overrides.md provides Kimi example" \
	"docs/model-overrides.md" \
	'--provider kimi-coding --model k/3'
assert_file_contains "skills/project-lead/SKILL.md provides Grok example" \
	"skills/project-lead/SKILL.md" \
	'--provider xai-auth --model grok-4\.5-latest'
assert_file_contains "skills/project-lead/SKILL.md provides Kimi example" \
	"skills/project-lead/SKILL.md" \
	'--provider kimi-coding --model k/3'
assert_file_contains "skills/conductor/SKILL.md provides Grok example" \
	"skills/conductor/SKILL.md" \
	'--provider xai-auth --model grok-4\.5-latest'
assert_file_contains "skills/conductor/SKILL.md provides Kimi example" \
	"skills/conductor/SKILL.md" \
	'--provider kimi-coding --model k/3'

# Verification quality preserved.
assert_file_contains "docs/model-overrides.md preserves verification quality" \
	"docs/model-overrides.md" \
	'verify every item against the PR.*actual head commit.*post evidence'
assert_file_contains "skills/project-lead/SKILL.md preserves verification quality" \
	"skills/project-lead/SKILL.md" \
	'verify every item against the PR.*actual head commit.*post evidence'
assert_file_contains "skills/conductor/SKILL.md preserves verification quality" \
	"skills/conductor/SKILL.md" \
	'compare Linear-ticket and PR-body AC against the PR.*actual head commit'

# Different-model independence preserved.
assert_file_contains "docs/model-overrides.md preserves model independence" \
	"docs/model-overrides.md" \
	'if the implementer ran on Grok, prefer Kimi for the reviewer and AC verifier \(and vice versa\)'
assert_file_contains "skills/project-lead/SKILL.md preserves model independence" \
	"skills/project-lead/SKILL.md" \
	'If the implementer ran on Grok, prefer Kimi for reviewer/verifier'
assert_file_contains "skills/conductor/SKILL.md preserves model independence" \
	"skills/conductor/SKILL.md" \
	'If the implementer ran on Grok, prefer Kimi for review/verification'

# Guard propagated to agents and profiles.
assert_file_contains "agents/project-lead.md propagates guard" \
	"agents/project-lead.md" \
	'Active GPT usage guard \(FLT-55\)'
assert_file_contains "agents/conductor.md propagates guard" \
	"agents/conductor.md" \
	'Active GPT usage guard \(FLT-55\)'
assert_file_contains "profiles/project-lead/profile.yml propagates guard" \
	"profiles/project-lead/profile.yml" \
	'ACTIVE GPT USAGE GUARD \(FLT-55\)'
assert_file_contains "profiles/conductor/profile.yml propagates guard" \
	"profiles/conductor/profile.yml" \
	'ACTIVE GPT USAGE GUARD \(FLT-55\)'

# README and quick-reference surfaces the guard.
assert_file_contains "README.md surfaces guard" \
	"README.md" \
	'Active GPT usage guard \(FLT-55\)'
assert_file_contains "bin/pi-fleet surfaces guard" \
	"bin/pi-fleet" \
	'GPT usage guard active'

# Eval README documents this structural guard.
assert_file_contains "evals/README.md documents FLT-55 structural guard" \
	"evals/README.md" \
	'gpt-usage-guard-structural-test\.sh'

# Avoid satisfying the ticket only in transient local handoff files.
grep_status=0
flt55_files="$(git -C "$DIR" grep -l 'FLT-55' -- . 2>/tmp/flt55-grep.err)" || grep_status=$?
if ((grep_status > 1)); then
	no "tracked FLT-55 content scan completed successfully"
	cat /tmp/flt55-grep.err
else
	ok "tracked FLT-55 content scan completed successfully"
	handoff_matches="$(printf '%s\n' "$flt55_files" | grep -E '(^|/)(handoff|tmp|notes)/|(^|/)(handoff|tmp|notes)($|\.)' || true)"
	canonical_matches="$(printf '%s\n' "$flt55_files" | grep -E '^(README\.md|bin/pi-fleet|docs/model-overrides\.md|skills/(project-lead|conductor)/SKILL\.md|agents/(project-lead|conductor)\.md|profiles/(project-lead|conductor)/profile\.yml|evals/README\.md|evals/gpt-usage-guard-structural-test\.sh)$' || true)"
	if [ -n "$handoff_matches" ] && [ -z "$canonical_matches" ]; then
		no "FLT-55 rule is not stored only in a local handoff/notes file"
		printf '%s\n' "$handoff_matches"
	elif [ -z "$canonical_matches" ]; then
		no "FLT-55 rule has canonical tracked-file evidence"
	else
		ok "FLT-55 rule has canonical tracked-file evidence"
		ok "FLT-55 rule is not stored only in a local handoff/notes file"
	fi
fi

echo "---"
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
