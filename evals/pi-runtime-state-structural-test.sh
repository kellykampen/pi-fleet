#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
[[ -f "$ROOT/docs/runtime-state.md" && -f "$ROOT/docs/runtime-state.schema.v1.json" ]]
python3 -m json.tool "$ROOT/docs/runtime-state.schema.v1.json" >/dev/null
for profile_file in "$ROOT"/profiles/*/profile.yml; do
	grep -q '../skills/fleet-state' "$profile_file"
done
for agent_file in "$ROOT"/agents/*.md; do
	grep -qi 'fleet-state' "$agent_file"
done
for phrase in 'ad-hoc top-level' 'secret' 'copied durable policy' 'exactly one' 'report-only' 'handoffs/conductor' 'handoffs/projects/<stable-id>' 'archive'; do
	grep -qi "$phrase" "$ROOT/skills/fleet-state/SKILL.md"
done
# Inspect extensionless bin executables as well as source/docs. Only migration/history may name legacy roots.
if grep -R -n -E '~?/\.pi/fleet|\$HOME/\.pi/fleet|Library/Logs/pi-fleet' \
	"$ROOT/bin" "$ROOT/extensions" "$ROOT/README.md" "$ROOT/docs" \
	--exclude='pi-fleet-state-migrate' --exclude='runtime-state.md'; then
	echo 'deprecated current runtime path found' >&2
	exit 1
fi
grep -q 'state/scheduler/backups' "$ROOT/bin/lib/scheduler-status.sh"
grep -q 'logs/personal' "$ROOT/bin/pi-personal-schedule-sync"
grep -q 'pi-fleet-state-migrate' "$ROOT/bin/pi-fleet-bootstrap"
echo 'ok - canonical runtime-state structure and fleet-state wiring'
