#!/usr/bin/env bash
# Enforce that Pi's external machine-global scheduler store is empty, preserving private evidence.
set -euo pipefail
LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=runtime-state.sh
. "$LIB_DIR/runtime-state.sh"
RUNTIME_ROOT="$(pi_fleet_runtime_root)"
TASKS_FILE="${PI_SCHEDULER_TASKS_FILE:-${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/state/scheduler/tasks.json}"
# Private evidence namespaces: <runtime-root>/state/scheduler/backups and quarantine.
STATE_DIR="$(pi_fleet_runtime_path state scheduler)"
LOCK_DIR="$STATE_DIR/.cleanup.lock"
umask 077
pi_fleet_assert_no_symlink_path "$TASKS_FILE"
mkdir -p "$STATE_DIR"
pi_fleet_assert_no_symlink_path "$STATE_DIR"
chmod 700 "$RUNTIME_ROOT" "$RUNTIME_ROOT/state" "$STATE_DIR"
for _attempt in $(seq 1 100); do
	if mkdir "$LOCK_DIR" 2>/dev/null; then break; fi
	sleep .05
	if [[ "$_attempt" == 100 ]]; then
		echo "pi-fleet scheduler: timed out acquiring cleanup lock" >&2
		exit 1
	fi
done
trap 'rmdir "$LOCK_DIR" 2>/dev/null || true' EXIT

result="$(
	python3 - "$TASKS_FILE" "$STATE_DIR" "$RUNTIME_ROOT" <<'PYEOF'
import json, os, shutil, stat, sys, tempfile, time, uuid
from pathlib import Path
path, state, runtime_root = map(Path, sys.argv[1:4])
def no_symlinks(target, boundary=None):
    boundary = boundary or target
    current = boundary
    for part in ("", *target.relative_to(boundary).parts):
        if part: current /= part
        try: mode = current.lstat().st_mode
        except FileNotFoundError: continue
        if stat.S_ISLNK(mode): raise RuntimeError(f"refusing symlink path: {current}")
no_symlinks(path); no_symlinks(state, runtime_root)
if not path.exists(): print("empty"); raise SystemExit
try: data = json.loads(path.read_text())
except Exception:
    q = state / "quarantine"; no_symlinks(q, state); q.mkdir(parents=True, exist_ok=True, mode=0o700); no_symlinks(q, state); q.chmod(0o700)
    dest = q / f"tasks.{time.time_ns()}.{uuid.uuid4().hex}.corrupt"; no_symlinks(dest, q)
    with path.open("rb") as source, dest.open("xb") as output: shutil.copyfileobj(source, output)
    dest.chmod(0o600)
    print("corrupt"); raise SystemExit
tasks = data.get("tasks", [])
if not tasks: print("empty"); raise SystemExit
backups = state / "backups"; no_symlinks(backups, state); backups.mkdir(parents=True, exist_ok=True, mode=0o700); no_symlinks(backups, state); backups.chmod(0o700)
backup = backups / f"tasks.{time.time_ns()}.{uuid.uuid4().hex}.json"; no_symlinks(backup, backups)
with backup.open("x") as f:
    json.dump(data, f, indent=2); f.write("\n"); f.flush(); os.fsync(f.fileno())
backup.chmod(0o600)
# Bound evidence to the newest 20 records.
for old in sorted(backups.glob("tasks.*.json"), key=lambda p: p.stat().st_mtime, reverse=True)[20:]: old.unlink()
data["tasks"] = []
no_symlinks(path.parent); path.parent.mkdir(parents=True, exist_ok=True); no_symlinks(path.parent)
fd, tmp = tempfile.mkstemp(prefix=f".{path.name}.tmp.", dir=path.parent)
try:
    with os.fdopen(fd, "w") as f:
        json.dump(data, f, indent=2); f.write("\n"); f.flush(); os.fsync(f.fileno())
    os.chmod(tmp, 0o600); os.replace(tmp, path)
finally:
    try: os.unlink(tmp)
    except FileNotFoundError: pass
print(f"purged:{len(tasks)}:{backup}")
PYEOF
)"
case "$result" in
corrupt)
	echo "pi-fleet scheduler: unknown global scheduled actions"
	echo "pi-fleet scheduler: WARNING corrupt input preserved; private copy under $STATE_DIR/quarantine" >&2
	;;
purged:*)
	count="${result#purged:}"
	count="${count%%:*}"
	backup="${result#purged:*:}"
	echo "pi-fleet scheduler: 0 global scheduled actions"
	echo "pi-fleet scheduler: WARNING purged $count leaked global task(s); private backup at $backup" >&2
	;;
*) echo "pi-fleet scheduler: 0 global scheduled actions" ;;
esac
