#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
HOME="$TMP/home"; export HOME
mkdir -p "$HOME/.pi/fleet/jobs" "$HOME/.pi-fleet/jobs"
printf '{"jobId":"legacy"}\n' > "$HOME/.pi/fleet/jobs/legacy.json"
printf 'TEST_SECRET=never-print-this\n' > "$HOME/.pi/fleet/secrets.env"
printf '{"jobId":"loose"}\n' > "$HOME/.pi-fleet/jobs/loose.json"

report="$($ROOT/bin/pi-fleet-state-migrate)"
[[ "$report" == *"report-only"* ]]
[[ "$report" != *"never-print-this"* ]]
[[ ! -e "$HOME/.pi-fleet/state/e2b/jobs/legacy.json" ]]

$ROOT/bin/pi-fleet-state-migrate --apply >/dev/null
[[ -f "$HOME/.pi-fleet/state/e2b/jobs/legacy.json" ]]
[[ -f "$HOME/.pi-fleet/state/e2b/jobs/loose.json" ]]
[[ -f "$HOME/.pi-fleet/secrets/secrets.env" ]]
[[ "$(stat -f '%Lp' "$HOME/.pi-fleet")" == 700 ]]
[[ "$(stat -f '%Lp' "$HOME/.pi-fleet/secrets/secrets.env")" == 600 ]]
manifest="$HOME/.pi-fleet/state/migrations/runtime-root-v1.json"
[[ -f "$manifest" && "$(stat -f '%Lp' "$manifest")" == 600 ]]

# Conflict is preserved, never overwritten.
printf 'destination\n' > "$HOME/.pi-fleet/state/e2b/jobs/conflict.json"
printf 'source\n' > "$HOME/.pi/fleet/jobs/conflict.json"
$ROOT/bin/pi-fleet-state-migrate --apply >/dev/null
[[ "$(cat "$HOME/.pi-fleet/state/e2b/jobs/conflict.json")" == destination ]]

# Rollback preserves modified destinations and removes unchanged migration-created ones only.
printf 'changed\n' > "$HOME/.pi-fleet/state/e2b/jobs/legacy.json"
$ROOT/bin/pi-fleet-state-migrate --rollback >/dev/null
[[ "$(cat "$HOME/.pi-fleet/state/e2b/jobs/legacy.json")" == changed ]]
[[ ! -e "$HOME/.pi-fleet/state/e2b/jobs/loose.json" ]]
[[ -e "$HOME/.pi/fleet/jobs/legacy.json" && -e "$HOME/.pi/fleet/secrets.env" ]]

PI_FLEET_HOME=relative bash -c '. "$1/bin/lib/runtime-state.sh"; pi_fleet_runtime_root' _ "$ROOT" >/dev/null 2>&1 && exit 1
mkdir "$TMP/real-root"; ln -s "$TMP/real-root" "$TMP/link-root"
PI_FLEET_HOME="$TMP/link-root" bash -c '. "$1/bin/lib/runtime-state.sh"; pi_fleet_runtime_root' _ "$ROOT" >/dev/null 2>&1 && exit 1
PI_FLEET_HOME="$TMP/link-root" "$ROOT/bin/pi-fleet-state-migrate" >/dev/null 2>&1 && exit 1
[[ "$(PI_FLEET_HOME="$TMP/custom" bash -c '. "$1/bin/lib/runtime-state.sh"; pi_fleet_runtime_root' _ "$ROOT")" == "$TMP/custom" ]]
echo 'ok - runtime root and non-destructive migration contract'
