#!/usr/bin/env bash
# Enforce that Pi's external machine-global scheduler store is empty, preserving private evidence.
set -euo pipefail
LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=runtime-state.sh
. "$LIB_DIR/runtime-state.sh"
RUNTIME_ROOT="$(pi_fleet_runtime_root)"
TASKS_FILE="${PI_SCHEDULER_TASKS_FILE:-${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/state/scheduler/tasks.json}"
# Private evidence namespaces: <runtime-root>/state/scheduler/backups and quarantine.
STATE_DIR="$RUNTIME_ROOT/state/scheduler"
LOCK_DIR="$STATE_DIR/.cleanup.lock"
umask 077
mkdir -p "$STATE_DIR"
chmod 700 "$RUNTIME_ROOT" "$RUNTIME_ROOT/state" "$STATE_DIR" 2>/dev/null || true
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
	python3 - "$TASKS_FILE" "$STATE_DIR" <<'PYEOF'
import json, os, shutil, sys, tempfile, time, uuid
from pathlib import Path
path, state = Path(sys.argv[1]), Path(sys.argv[2])
if not path.exists(): print("empty"); raise SystemExit
try: data = json.loads(path.read_text())
except Exception:
    q = state / "quarantine"; q.mkdir(parents=True, exist_ok=True, mode=0o700); q.chmod(0o700)
    dest = q / f"tasks.{time.time_ns()}.{uuid.uuid4().hex}.corrupt"
    shutil.copyfile(path, dest); dest.chmod(0o600)
    print("corrupt"); raise SystemExit
tasks = data.get("tasks", [])
if not tasks: print("empty"); raise SystemExit
backups = state / "backups"; backups.mkdir(parents=True, exist_ok=True, mode=0o700); backups.chmod(0o700)
backup = backups / f"tasks.{time.time_ns()}.{uuid.uuid4().hex}.json"
with backup.open("x") as f:
    json.dump(data, f, indent=2); f.write("\n"); f.flush(); os.fsync(f.fileno())
backup.chmod(0o600)
# Bound evidence to the newest 20 records.
for old in sorted(backups.glob("tasks.*.json"), key=lambda p: p.stat().st_mtime, reverse=True)[20:]: old.unlink()
data["tasks"] = []
path.parent.mkdir(parents=True, exist_ok=True)
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
