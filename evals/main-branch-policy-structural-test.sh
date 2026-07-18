#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# Current workflow guidance, defaults, and executable policy must not target the deleted branch.
matches="$(grep -R -n -w develop \
	"$ROOT/skills" "$ROOT/profiles" "$ROOT/agents" "$ROOT/README.md" "$ROOT/docs" \
	"$ROOT/claude-settings" "$ROOT/bin/lib" "$ROOT/bin/pi-fleet-eval-conductor-policy" \
	"$ROOT/extensions/e2b/secrets.ts" 2>&1)" && grep_status=0 || grep_status=$?
if (( grep_status == 0 )); then
	printf '%s\n' "$matches"
	echo "deleted develop branch remains in current policy or guidance" >&2
	exit 1
elif (( grep_status > 1 )); then
	printf '%s\n' "$matches" >&2
	exit "$grep_status"
fi

grep -q 'merge.*main' "$ROOT/skills/project-lead/SKILL.md"
grep -q 'merges.*main' "$ROOT/skills/conductor/SKILL.md"
[ "$(grep -c 'job.fleetRef || "main"' "$ROOT/extensions/e2b/secrets.ts")" -eq 2 ]

echo 'ok - canonical workflow and fleetRef defaults target main'
