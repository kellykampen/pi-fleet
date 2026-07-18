#!/usr/bin/env bash
# Remove only validated pi-fleet leaks from Pi's external scheduler store, preserving private evidence.
set -euo pipefail
LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=runtime-state.sh
. "$LIB_DIR/runtime-state.sh"
RUNTIME_ROOT="$(pi_fleet_runtime_root)"
if [[ -n "${PI_SCHEDULER_TASKS_FILE:-}" ]]; then
	TASKS_FILE="$PI_SCHEDULER_TASKS_FILE"
	TASKS_BOUNDARY="${PI_SCHEDULER_TASKS_BOUNDARY:?PI_SCHEDULER_TASKS_BOUNDARY is required with PI_SCHEDULER_TASKS_FILE}"
else
	TASKS_BOUNDARY="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
	TASKS_FILE="$TASKS_BOUNDARY/state/scheduler/tasks.json"
fi
resolved_tasks_paths="$(python3 - "$TASKS_FILE" "$TASKS_BOUNDARY" <<'PY'
import os, sys
path, boundary = sys.argv[1:]
if not os.path.isabs(path) or not os.path.isabs(boundary):
    raise SystemExit("scheduler paths must be absolute")
if os.path.commonpath((path, boundary)) != boundary:
    raise SystemExit("scheduler tasks path escapes its trusted boundary")
relative = os.path.relpath(path, boundary)
canonical_boundary = os.path.realpath(boundary)
print(canonical_boundary)
print(os.path.normpath(os.path.join(canonical_boundary, relative)))
PY
)"
TASKS_BOUNDARY="${resolved_tasks_paths%%$'\n'*}"
TASKS_FILE="${resolved_tasks_paths#*$'\n'}"
# Private evidence namespaces: state/scheduler/backups and state/scheduler/quarantine.
STATE_DIR="$(pi_fleet_runtime_path state scheduler)"
LOCK_DIR="$STATE_DIR/.cleanup.lock"
umask 077
pi_fleet_assert_no_symlink_path "$TASKS_FILE" "$TASKS_BOUNDARY"
mkdir -p "$STATE_DIR"
pi_fleet_assert_no_symlink_path "$STATE_DIR" "$RUNTIME_ROOT"
chmod 700 "$RUNTIME_ROOT" "$RUNTIME_ROOT/state" "$STATE_DIR"
for _attempt in $(seq 1 100); do
	if mkdir "$LOCK_DIR" 2>/dev/null; then break; fi
	if [[ ! -d "$LOCK_DIR" || -L "$LOCK_DIR" ]]; then
		echo "pi-fleet scheduler: unable to acquire cleanup lock" >&2
		exit 1
	fi
	if [[ "$_attempt" == 100 ]]; then
		echo "pi-fleet scheduler: timed out acquiring cleanup lock" >&2
		exit 1
	fi
	sleep .05
done
trap 'rmdir "$LOCK_DIR" 2>/dev/null || true' EXIT

result="$(
	python3 - "$TASKS_FILE" "$TASKS_BOUNDARY" "$STATE_DIR" "$RUNTIME_ROOT" <<'PYEOF'
import json, os, shutil, stat, sys, tempfile, time, uuid
from pathlib import Path
path, tasks_boundary, state, runtime_root = map(Path, sys.argv[1:5])

def no_symlinks(target, boundary):
    target = Path(os.path.abspath(target)); boundary = Path(os.path.abspath(boundary))
    try: relative = target.relative_to(boundary)
    except ValueError: raise RuntimeError(f"path escapes validation boundary: {target}")
    current = boundary
    for part in ("", *relative.parts):
        if part: current /= part
        try: mode = current.lstat().st_mode
        except FileNotFoundError: continue
        if stat.S_ISLNK(mode): raise RuntimeError(f"refusing symlink path: {current}")

def bounded(directory, pattern, limit=20):
    records = sorted(directory.glob(pattern), key=lambda p: p.stat().st_mtime, reverse=True)
    for old in records[limit:]:
        no_symlinks(old, directory)
        old.unlink()

def quarantine():
    q = state / "quarantine"; no_symlinks(q, state); q.mkdir(parents=True, exist_ok=True, mode=0o700); no_symlinks(q, state); q.chmod(0o700)
    dest = q / f"tasks.{time.time_ns()}.{uuid.uuid4().hex}.corrupt"; no_symlinks(dest, q)
    with path.open("rb") as source, dest.open("xb") as output: shutil.copyfileobj(source, output)
    dest.chmod(0o600)

no_symlinks(path, tasks_boundary); no_symlinks(state, runtime_root)
if not path.exists(): print("empty"); raise SystemExit
try:
    original_bytes = path.read_bytes()
    data = json.loads(original_bytes)
    if not isinstance(data, dict) or not isinstance(data.get("tasks", []), list):
        raise ValueError("invalid scheduler schema")
except Exception:
    quarantine(); print("corrupt"); raise SystemExit

tasks = data.get("tasks", [])
if not tasks: print("empty"); raise SystemExit

def fleet_owned(task):
    if not isinstance(task, dict): return False
    name = task.get("name")
    task_id = task.get("id")
    return task.get("scope") == "global" and (
        name in {"social-x-checkup", "gmail-reply-checkup"}
        or task.get("owner") == "pi-fleet"
        or (isinstance(name, str) and name.startswith("dev.pi-fleet."))
        or (isinstance(task_id, str) and task_id.startswith("pi-fleet-"))
    )

removed = [task for task in tasks if fleet_owned(task)]
remaining = [task for task in tasks if not fleet_owned(task)]
if not removed:
    print(f"external:{len(tasks)}"); raise SystemExit
backups = state / "backups"; no_symlinks(backups, state); backups.mkdir(parents=True, exist_ok=True, mode=0o700); no_symlinks(backups, state); backups.chmod(0o700)
backup = backups / f"tasks.{time.time_ns()}.{uuid.uuid4().hex}.json"; no_symlinks(backup, backups)
with backup.open("x") as f:
    json.dump({**data, "tasks": removed}, f, indent=2); f.write("\n"); f.flush(); os.fsync(f.fileno())
backup.chmod(0o600)
data["tasks"] = remaining
no_symlinks(path.parent, tasks_boundary); path.parent.mkdir(parents=True, exist_ok=True); no_symlinks(path.parent, tasks_boundary)
fd, tmp = tempfile.mkstemp(prefix=f".{path.name}.tmp.", dir=path.parent)
try:
    with os.fdopen(fd, "w") as f:
        json.dump(data, f, indent=2); f.write("\n"); f.flush(); os.fsync(f.fileno())
    os.chmod(tmp, 0o600)
    try: unchanged = path.read_bytes() == original_bytes
    except FileNotFoundError: unchanged = False
    if not unchanged:
        backup.unlink(missing_ok=True)
        print("changed")
        raise SystemExit
    os.replace(tmp, path)
    # Evidence pruning is allowed only after the validated task purge commits.
    # A pruning failure must not mask the completed atomic replacement.
    try:
        bounded(backups, "tasks.*.json")
        quarantine_dir = state / "quarantine"
        if quarantine_dir.exists(): bounded(quarantine_dir, "tasks.*.corrupt")
    except OSError as error:
        print(f"pi-fleet scheduler: warning: evidence pruning failed: {error}", file=sys.stderr)
finally:
    try: os.unlink(tmp)
    except FileNotFoundError: pass
print(f"purged:{len(removed)}:{len(remaining)}:{backup}")
PYEOF
)"
case "$result" in
corrupt)
	echo "pi-fleet scheduler: unknown global scheduled actions"
	echo "pi-fleet scheduler: WARNING corrupt input preserved; private copy under $STATE_DIR/quarantine" >&2
	;;
external:*)
	echo "pi-fleet scheduler: ${result#external:} external scheduled action(s) preserved"
	;;
changed)
	echo "pi-fleet scheduler: scheduler state changed concurrently; no cleanup applied" >&2
	;;
purged:*)
	payload="${result#purged:}"; count="${payload%%:*}"; payload="${payload#*:}"
	remaining="${payload%%:*}"; backup="${payload#*:}"
	if [[ "$remaining" == 0 ]]; then
		echo "pi-fleet scheduler: 0 global scheduled actions"
	else
		echo "pi-fleet scheduler: $remaining external scheduled action(s) preserved"
	fi
	echo "pi-fleet scheduler: WARNING purged $count leaked pi-fleet task(s); private backup at $backup" >&2
	;;
*) echo "pi-fleet scheduler: 0 global scheduled actions" ;;
esac
