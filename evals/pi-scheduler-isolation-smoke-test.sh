#!/usr/bin/env bash
# FLT-35: non-personal lead roles expose zero-task evidence without installing personal schedules.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT
TASKS="$TMPDIR/tasks.json"
printf '{"version":2,"tasks":[]}\n' > "$TASKS"

for wrapper in pi-conductor pi-project-lead; do
  grep -q 'scheduler-status.sh' "$ROOT/bin/$wrapper"
  ! grep -q 'pi-personal-schedule-sync' "$ROOT/bin/$wrapper"
done

OUTPUT="$(PI_SCHEDULER_TASKS_FILE="$TASKS" "$ROOT/bin/lib/scheduler-status.sh")"
[[ "$OUTPUT" == *"0 global scheduled actions"* ]]
[[ "$(cat "$TASKS")" == '{"version":2,"tasks":[]}' ]]
printf 'ok - conductor/project-lead report zero global scheduled actions without mutating tasks.json\n'
