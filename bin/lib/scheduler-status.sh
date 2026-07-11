#!/usr/bin/env bash
# Enforce (not just report) that the deprecated machine-global pi scheduler store is empty.
# Personal schedules belong to launchd and must never appear here. Other pi runtimes (e.g. the
# remote-pi/dev.remotepi.supervisord daemon) can still register or replay tasks into this file
# from outside this repo, so every non-personal start/restart and every personal schedule sync
# purges whatever is found - leaked tasks are backed up alongside the store, not silently dropped.
set -euo pipefail

TASKS_FILE="${PI_SCHEDULER_TASKS_FILE:-${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/state/scheduler/tasks.json}"
purged="$(
	python3 - "$TASKS_FILE" <<'PYEOF'
import datetime, json, os, sys

path = sys.argv[1]
if not os.path.exists(path):
    print(0)
    raise SystemExit

try:
    with open(path) as f:
        data = json.load(f)
except Exception:
    print("unknown")
    raise SystemExit

tasks = data.get("tasks", [])
if not tasks:
    print(0)
    raise SystemExit

# Preserve evidence of what leaked before purging it.
stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
backup_path = f"{path}.bak.{stamp}"
with open(backup_path, "w") as f:
    json.dump(data, f, indent=2)
    f.write("\n")

data["tasks"] = []
tmp_path = f"{path}.tmp.{os.getpid()}"
with open(tmp_path, "w") as f:
    json.dump(data, f, indent=2)
    f.write("\n")
os.replace(tmp_path, path)

print(len(tasks))
PYEOF
)"

if [[ "$purged" == "unknown" ]]; then
	echo "pi-fleet scheduler: unknown global scheduled actions" >&2
	echo "pi-fleet scheduler: WARNING could not parse $TASKS_FILE" >&2
elif [[ "$purged" != "0" ]]; then
	echo "pi-fleet scheduler: 0 global scheduled actions"
	echo "pi-fleet scheduler: WARNING purged $purged leaked global task(s); backup at ${TASKS_FILE}.bak.*; personal schedules must use launchd" >&2
	echo "pi-fleet scheduler: if this recurs, a live process is re-registering tasks - check: launchctl list | grep dev.remotepi.supervisord" >&2
else
	echo "pi-fleet scheduler: 0 global scheduled actions"
fi
