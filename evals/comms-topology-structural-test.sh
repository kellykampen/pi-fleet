#!/usr/bin/env bash
# FLT-57 regression guard for the fleet communication topology.
#
# Ensures allowed edges, forbidden bypasses, rollup cadence/format, worker report
# discipline, and QC restatements are codified in canonical source-of-truth files.
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

# Core topology section present in lead + conductor skills.
assert_file_contains "skills/project-lead/SKILL.md names communication topology" \
	"skills/project-lead/SKILL.md" \
	'Communication topology \(FLT-57\)'
assert_file_contains "skills/conductor/SKILL.md names communication topology" \
	"skills/conductor/SKILL.md" \
	'Communication topology \(FLT-57\)'

# Allowed edges.
assert_file_contains "project-lead skill allows worker/reviewer/AC ↔ lead" \
	"skills/project-lead/SKILL.md" \
	'worker\s*/\s*reviewer\s*/\s*AC-verifier\s*↔\s*project lead'
assert_file_contains "project-lead skill allows lead ↔ conductor" \
	"skills/project-lead/SKILL.md" \
	'project lead\s*↔\s*conductor/coordinator'
assert_file_contains "conductor skill allows lead ↔ conductor" \
	"skills/conductor/SKILL.md" \
	'project lead\s*↔\s*conductor/coordinator'
assert_file_contains "conductor skill allows conductor ↔ CEO" \
	"skills/conductor/SKILL.md" \
	'conductor/coordinator\s*↔\s*CEO\s*/\s*cross-project'

# Forbidden edges / anti-patterns.
assert_file_contains "project-lead skill forbids workers messaging conductor/CEO" \
	"skills/project-lead/SKILL.md" \
	'Workers[\s\S]*messaging the conductor/coordinator or CEO'
assert_file_contains "project-lead skill forbids conductor messaging workers" \
	"skills/project-lead/SKILL.md" \
	'Conductor/coordinator messaging workers directly'
assert_file_contains "project-lead skill forbids drip-feed status" \
	"skills/project-lead/SKILL.md" \
	'[Dd]rip-feed status'
assert_file_contains "project-lead skill forbids pane-tail spam" \
	"skills/project-lead/SKILL.md" \
	'[Pp]ane-tail spam'
assert_file_contains "conductor skill forbids messaging workers directly" \
	"skills/conductor/SKILL.md" \
	'Messaging workers directly'
assert_file_contains "conductor skill forbids drip-feed and pane-tail spam" \
	"skills/conductor/SKILL.md" \
	'[Dd]rip-feed status[\s\S]*[Pp]ane-tail spam|[Pp]ane-tail spam[\s\S]*[Dd]rip-feed'

# Cadence + rollup format.
assert_file_contains "project-lead skill requires 5-10 min or state-change rollup" \
	"skills/project-lead/SKILL.md" \
	'every 5–10 minutes|every 5-10 min'
assert_file_contains "project-lead skill includes STATUS rollup format" \
	"skills/project-lead/SKILL.md" \
	'STATUS t=.*PRs:.*CI=.*AC=.*block=.*agents:.*need:'
assert_file_contains "conductor skill demands STATUS rollup format" \
	"skills/conductor/SKILL.md" \
	'STATUS t=.*PRs:.*CI=.*AC=.*block=.*agents:.*need:'

# Worker report discipline.
assert_file_contains "project-lead skill: workers report final done/blocked only" \
	"skills/project-lead/SKILL.md" \
	'final done.*blocked|final done/blocked'
assert_file_contains "implementation skill reports to project lead only" \
	"skills/implementation/SKILL.md" \
	'project lead only|to the project lead only'
assert_file_contains "implementation skill forbids messaging conductor/CEO" \
	"skills/implementation/SKILL.md" \
	'never the conductor/coordinator, never the CEO|Never message the conductor'
assert_file_contains "code-review skill reports to project lead only" \
	"skills/code-review/SKILL.md" \
	'project lead only'
assert_file_contains "code-review skill forbids messaging conductor/CEO" \
	"skills/code-review/SKILL.md" \
	'never conductor/coordinator or CEO|Never message the conductor'

# QC restatement.
for file in \
	"skills/project-lead/SKILL.md" \
	"skills/conductor/SKILL.md"
do
	assert_file_contains "$file restates independent reviewer + dedicated AC" \
		"$file" \
		'[Ii]ndependent[\s\S]*different-model reviewer[\s\S]*dedicated[\s\S]*(AC|`pi-ac-verifier`)'
	assert_file_contains "$file restates no self-tick" \
		"$file" \
		'[Nn]o self-tick'
	assert_file_contains "$file restates no automerge" \
		"$file" \
		'[Nn]o automerge'
	assert_file_contains "$file restates no lead merge without CEO-mandated DoD" \
		"$file" \
		'[Nn]o lead merge without CEO-mandated DoD'
done

# Profiles / agents propagate topology.
assert_file_contains "profiles/project-lead propagates topology" \
	"profiles/project-lead/profile.yml" \
	'Communication topology \(FLT-57\)'
assert_file_contains "profiles/conductor propagates topology" \
	"profiles/conductor/profile.yml" \
	'Communication topology \(FLT-57\)'
assert_file_contains "profiles/implementer reports to lead only" \
	"profiles/implementer/profile.yml" \
	'report only to the project lead'
assert_file_contains "profiles/reviewer reports to lead only" \
	"profiles/reviewer/profile.yml" \
	'report only to the project lead'
assert_file_contains "profiles/ac-verifier reports to lead only" \
	"profiles/ac-verifier/profile.yml" \
	'report only to the project lead'
assert_file_contains "agents/project-lead propagates topology" \
	"agents/project-lead.md" \
	'Communication topology \(FLT-57\)'
assert_file_contains "agents/conductor propagates topology" \
	"agents/conductor.md" \
	'Communication topology \(FLT-57\)'
assert_file_contains "agents/implementer reports to lead only" \
	"agents/implementer.md" \
	'project lead only'
assert_file_contains "agents/reviewer reports to lead only" \
	"agents/reviewer.md" \
	'project lead only'
assert_file_contains "agents/ac-verifier reports to lead only" \
	"agents/ac-verifier.md" \
	'project lead only'

# README one-liner.
assert_file_contains "README.md surfaces topology" \
	"README.md" \
	'Communication topology \(FLT-57\)'

# Eval README documents this structural guard.
assert_file_contains "evals/README.md documents FLT-57 structural guard" \
	"evals/README.md" \
	'comms-topology-structural-test\.sh'

# Preserve harness delegate-only boundary (do not regress FLT-52/delegate-guard).
assert_file_contains "project-lead skill still forbids self-implementation" \
	"skills/project-lead/SKILL.md" \
	'do not implement, review, AC-verify, docs-pass, or "just do a light'
assert_file_contains "project-lead profile still forbids self-implementation" \
	"profiles/project-lead/profile.yml" \
	'Never implement, review, AC-verify, or docs-pass in your own session'
assert_file_contains "project-lead skill still merges fully gated PRs to main" \
	"skills/project-lead/SKILL.md" \
	'merge the fully gated PR directly to \*\*main\*\*'
assert_file_contains "conductor skill still says leads merge to main" \
	"skills/conductor/SKILL.md" \
	'merges? fully gated[\s\S]*main|project lead merges directly to main'

echo "---"
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
