#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
[[ -f "$ROOT/docs/runtime-state.md" && -f "$ROOT/docs/runtime-state.schema.v1.json" ]]
python3 -m json.tool "$ROOT/docs/runtime-state.schema.v1.json" >/dev/null
for profile in conductor project-lead personal-assistant implementer reviewer; do
	grep -q '../skills/fleet-state' "$ROOT/profiles/$profile/profile.yml"
done
for agent in conductor project-lead implementer reviewer; do
	grep -qi 'fleet-state' "$ROOT/agents/$agent.md"
done
for phrase in 'ad-hoc top-level' 'secret' 'copied durable policy' 'exactly one' 'report-only' 'handoffs/conductor' 'handoffs/projects/<stable-id>' 'archive'; do
	grep -qi "$phrase" "$ROOT/skills/fleet-state/SKILL.md"
done
# Current production/docs guidance must use the canonical root. Historical/migration material and tests are excluded.
if grep -R -n -E '~?/\.pi/fleet|Library/Logs/pi-fleet' "$ROOT/bin" "$ROOT/extensions" "$ROOT/README.md" "$ROOT/docs" \
	--include='*.sh' --include='*.ts' --include='*.md' | grep -v 'pi-fleet-state-migrate' | grep -v 'runtime-state.md'; then
	echo 'deprecated current runtime path found' >&2
	exit 1
fi
grep -q 'state/scheduler/backups' "$ROOT/bin/lib/scheduler-status.sh"
grep -q 'logs/personal' "$ROOT/bin/pi-personal-schedule-sync"
grep -q 'pi-fleet-state-migrate' "$ROOT/bin/pi-fleet-bootstrap"
echo 'ok - canonical runtime-state structure and fleet-state wiring'
