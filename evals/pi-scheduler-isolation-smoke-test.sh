#!/usr/bin/env bash
# FLT-35: non-personal lead roles expose zero-task evidence without installing personal schedules.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT
export PI_FLEET_HOME="$TMPDIR/fleet-home"
TASKS="$TMPDIR/tasks.json"
export PI_SCHEDULER_TASKS_BOUNDARY="$TMPDIR"
printf '{"version":2,"tasks":[]}\n' >"$TASKS"

for wrapper in pi-conductor pi-project-lead; do
	grep -q 'scheduler-status.sh' "$ROOT/bin/$wrapper"
	! grep -q 'pi-personal-schedule-sync' "$ROOT/bin/$wrapper"
done

# FLT-35 structural fix: --no-extensions blocks machine-global package auto-discovery (e.g.
# @jl1990/pi-scheduler) so it can never re-enter conductor/project-lead sessions, while explicit
# --extension flags (still required for Linear/E2B tools) are unaffected and keep loading.
grep -q -- '--no-extensions' "$ROOT/bin/pi-conductor"
grep -q -- '--extension "\$FLEET_ROOT/extensions/linear.ts"' "$ROOT/bin/pi-conductor"
grep -q -- '--no-extensions' "$ROOT/bin/pi-project-lead"
if grep -q -- '--no-lens' "$ROOT/bin/pi-project-lead"; then
	echo 'not ok - pi-project-lead must not pass unsupported --no-lens with --no-extensions' >&2
	exit 1
fi
grep -q -- '--extension "\$FLEET_ROOT/extensions/linear.ts"' "$ROOT/bin/pi-project-lead"
grep -q -- '--extension "\$FLEET_ROOT/extensions/e2b"' "$ROOT/bin/pi-project-lead"
printf 'ok - conductor/project-lead pass --no-extensions without --no-lens while explicit --extension flags still load\n'

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
backups=("$PI_FLEET_HOME/state/scheduler/backups"/*.json)
shopt -u nullglob
[[ "${#backups[@]}" -ge 1 ]]
[[ "$(stat -f '%Lp' "$PI_FLEET_HOME/state/scheduler/backups")" == 700 ]]
[[ "$(stat -f '%Lp' "${backups[0]}")" == 600 ]]
[[ "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["tasks"][0]["name"])' "${backups[0]}")" == "social-x-checkup" ]]
printf 'ok - scheduler-status.sh purges leaked global tasks and preserves a private bounded backup\n'

before_backup_count="${#backups[@]}"
printf '{"version":2,"tasks":[{"id":"pi-fleet-one","scope":"global","owner":"pi-fleet"}]}' >"$LEAKED"
PI_SCHEDULER_TASKS_FILE="$LEAKED" "$ROOT/bin/lib/scheduler-status.sh" >/dev/null &
p1=$!
PI_SCHEDULER_TASKS_FILE="$LEAKED" "$ROOT/bin/lib/scheduler-status.sh" >/dev/null &
p2=$!
wait "$p1"
wait "$p2"
[[ "$(python3 -c 'import json,sys; print(len(json.load(open(sys.argv[1]))["tasks"]))' "$LEAKED")" == 0 ]]
shopt -s nullglob
backups=("$PI_FLEET_HOME/state/scheduler/backups"/*.json)
shopt -u nullglob
[[ "${#backups[@]}" -eq "$((before_backup_count + 1))" ]]

printf '{"version":2,"tasks":[{"id":"external","scope":"global","name":"external-task"}]}' >"$LEAKED"
PI_SCHEDULER_TASKS_FILE="$LEAKED" "$ROOT/bin/lib/scheduler-status.sh" >/dev/null
[[ "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["tasks"][0]["id"])' "$LEAKED")" == external ]]
for invalid in 'not-json' '[]' 'null' '{"tasks":{}}'; do
	printf '%s' "$invalid" >"$LEAKED"
	before="$(shasum "$LEAKED")"
	PI_SCHEDULER_TASKS_FILE="$LEAKED" "$ROOT/bin/lib/scheduler-status.sh" >/dev/null
	[[ "$(shasum "$LEAKED")" == "$before" ]]
done
shopt -s nullglob
corrupt=("$PI_FLEET_HOME/state/scheduler/quarantine"/*)
shopt -u nullglob
[[ "${#corrupt[@]}" -eq 4 && "$(stat -f '%Lp' "${corrupt[0]}")" == 600 ]]
printf 'ok - scheduler cleanup is locked, atomic, preserves external tasks, and quarantines invalid schemas\n'

# Every nested runtime writer path rejects symlinks instead of writing through them.
SYMLINK_ROOT="$TMPDIR/symlink-fleet"; OUTSIDE="$TMPDIR/outside"; mkdir -p "$SYMLINK_ROOT/state" "$OUTSIDE"
ln -s "$OUTSIDE" "$SYMLINK_ROOT/state/scheduler"
printf '{"version":2,"tasks":[{"id":"unsafe"}]}' > "$TMPDIR/unsafe-tasks.json"
if PI_FLEET_HOME="$SYMLINK_ROOT" PI_SCHEDULER_TASKS_FILE="$TMPDIR/unsafe-tasks.json" "$ROOT/bin/lib/scheduler-status.sh" >/dev/null 2>&1; then
	echo 'not ok - nested scheduler symlink accepted' >&2; exit 1
fi
[[ -z "$(find "$OUTSIDE" -mindepth 1 -print -quit)" ]]
printf 'ok - scheduler nested symlinks are rejected without outside writes\n'

TASK_PARENT="$TMPDIR/task-parent"; TASK_OUTSIDE="$TMPDIR/task-outside"; mkdir "$TASK_PARENT" "$TASK_OUTSIDE"
ln -s "$TASK_OUTSIDE" "$TASK_PARENT/link"
printf '{"version":2,"tasks":[{"id":"pi-fleet-unsafe","scope":"global","owner":"pi-fleet"}]}' >"$TASK_OUTSIDE/tasks.json"
if PI_SCHEDULER_TASKS_FILE="$TASK_PARENT/link/tasks.json" "$ROOT/bin/lib/scheduler-status.sh" >/dev/null 2>&1; then
	echo 'not ok - scheduler task ancestor symlink accepted' >&2; exit 1
fi
[[ "$(python3 -c 'import json,sys; print(len(json.load(open(sys.argv[1]))["tasks"]))' "$TASK_OUTSIDE/tasks.json")" == 1 ]]
printf 'ok - scheduler task-file ancestry is canonicalized and cannot be redirected during cleanup\n'
