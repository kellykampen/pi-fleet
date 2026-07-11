#!/usr/bin/env bash
# FLT-35: non-personal lead roles expose zero-task evidence without installing personal schedules.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT
TASKS="$TMPDIR/tasks.json"
printf '{"version":2,"tasks":[]}\n' >"$TASKS"

for wrapper in pi-conductor pi-project-lead; do
	grep -q 'scheduler-status.sh' "$ROOT/bin/$wrapper"
	! grep -q 'pi-personal-schedule-sync' "$ROOT/bin/$wrapper"
done

OUTPUT="$(PI_SCHEDULER_TASKS_FILE="$TASKS" "$ROOT/bin/lib/scheduler-status.sh")"
[[ "$OUTPUT" == *"0 global scheduled actions"* ]]
[[ "$(cat "$TASKS")" == '{"version":2,"tasks":[]}' ]]
printf 'ok - conductor/project-lead report zero global scheduled actions without mutating tasks.json\n'

# FLT-35 regression: a leaked/replayed global task (e.g. from remote-pi/dev.remotepi.supervisord,
# or a pre-PR#39 state) must be purged, not just reported, on the next status check.
LEAKED="$TMPDIR/leaked-tasks.json"
printf '{"version":2,"updatedAt":"2026-07-11T16:15:34.734Z","tasks":[{"id":"task_leaked","scope":"global","name":"social-x-checkup"}]}\n' >"$LEAKED"
LEAK_OUTPUT="$(PI_SCHEDULER_TASKS_FILE="$LEAKED" "$ROOT/bin/lib/scheduler-status.sh")"
[[ "$LEAK_OUTPUT" == *"0 global scheduled actions"* ]]
[[ "$(python3 -c 'import json,sys; print(len(json.load(open(sys.argv[1]))["tasks"]))' "$LEAKED")" == "0" ]]
shopt -s nullglob
backups=("$LEAKED".bak.*)
shopt -u nullglob
[[ "${#backups[@]}" -ge 1 ]]
[[ "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["tasks"][0]["name"])' "${backups[0]}")" == "social-x-checkup" ]]
printf 'ok - scheduler-status.sh purges leaked global tasks and preserves a backup for evidence\n'
