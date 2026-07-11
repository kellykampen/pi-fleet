#!/usr/bin/env bash
# Read-only runtime evidence for the deprecated machine-global pi scheduler store.
# Personal schedules belong to launchd and must never appear here.
set -euo pipefail

TASKS_FILE="${PI_SCHEDULER_TASKS_FILE:-${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/state/scheduler/tasks.json}"
count="$(python3 - "$TASKS_FILE" <<'PYEOF'
import json, os, sys
path = sys.argv[1]
if not os.path.exists(path):
    print(0)
    raise SystemExit
try:
    with open(path) as f:
        data = json.load(f)
    print(len(data.get("tasks", [])))
except Exception:
    print("unknown")
PYEOF
)"

echo "pi-fleet scheduler: $count global scheduled actions"
if [[ "$count" != "0" ]]; then
  echo "pi-fleet scheduler: WARNING expected zero; personal schedules must use launchd" >&2
fi
