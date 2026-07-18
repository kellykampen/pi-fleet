#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
HOME="$TMP/home"
export HOME
export PI_FLEET_HOME="$HOME/.pi-fleet"
mkdir -p "$HOME/.pi/fleet/jobs" "$PI_FLEET_HOME/jobs" "$PI_FLEET_HOME/notes/subdir"
printf '{"jobId":"legacy"}\n' >"$HOME/.pi/fleet/jobs/legacy.json"
printf 'export E2B_API_KEY="never-print-this quoted"\nGH_TOKEN='"'"'legacy-token'"'"'\n' >"$HOME/.pi/fleet/secrets.env"
printf '{"jobId":"loose"}\n' >"$PI_FLEET_HOME/jobs/loose.json"
printf 'legacy note\n' >"$PI_FLEET_HOME/note.txt"
printf 'loose source\n' >"$PI_FLEET_HOME/conflict-note.txt"
printf 'nested\n' >"$PI_FLEET_HOME/notes/subdir/item.txt"
mkdir -p "$PI_FLEET_HOME/archive/legacy-root"
printf 'archive destination\n' >"$PI_FLEET_HOME/archive/legacy-root/conflict-note.txt"

report="$($ROOT/bin/pi-fleet-state-migrate)"
[[ "$report" == *"report-only"* && "$report" != *"never-print-this"* ]]
[[ ! -e "$PI_FLEET_HOME/state/e2b/jobs/legacy.json" ]]
[[ ! -e "$PI_FLEET_HOME/archive/legacy-root/note.txt" ]]

"$ROOT/bin/pi-fleet-state-migrate" --apply >/dev/null
[[ -f "$PI_FLEET_HOME/state/e2b/jobs/legacy.json" ]]
[[ -f "$PI_FLEET_HOME/state/e2b/jobs/loose.json" ]]
[[ -f "$PI_FLEET_HOME/secrets/secrets.env" ]]
grep -Fxq 'E2B_API_KEY=never-print-this quoted' "$PI_FLEET_HOME/secrets/secrets.env"
grep -Fxq 'GH_TOKEN=legacy-token' "$PI_FLEET_HOME/secrets/secrets.env"
[[ -f "$PI_FLEET_HOME/archive/legacy-root/note.txt" ]]
[[ "$(cat "$PI_FLEET_HOME/archive/legacy-root/conflict-note.txt")" == 'archive destination' ]]
[[ -f "$PI_FLEET_HOME/archive/legacy-root/notes/subdir/item.txt" ]]
[[ -f "$PI_FLEET_HOME/note.txt" && -f "$PI_FLEET_HOME/notes/subdir/item.txt" ]]
[[ ! -e "$PI_FLEET_HOME/archive/legacy-root/state" && ! -e "$PI_FLEET_HOME/archive/legacy-root/secrets" ]]
[[ "$(stat -f '%Lp' "$PI_FLEET_HOME")" == 700 ]]
[[ "$(stat -f '%Lp' "$PI_FLEET_HOME/secrets/secrets.env")" == 600 ]]
manifest="$PI_FLEET_HOME/state/migrations/runtime-root-v1.json"
[[ -f "$manifest" && "$(stat -f '%Lp' "$manifest")" == 600 ]]

# Conflicts are preserved and concurrent publication never clobbers either destination or manifest.
printf 'destination\n' >"$PI_FLEET_HOME/state/e2b/jobs/conflict.json"
printf 'source\n' >"$HOME/.pi/fleet/jobs/conflict.json"
"$ROOT/bin/pi-fleet-state-migrate" --apply >/dev/null &
p1=$!
"$ROOT/bin/pi-fleet-state-migrate" --apply >/dev/null &
p2=$!
wait "$p1"
wait "$p2"
[[ "$(cat "$PI_FLEET_HOME/state/e2b/jobs/conflict.json")" == destination ]]
python3 -m json.tool "$manifest" >/dev/null
mkdir "$PI_FLEET_HOME/state/migrations/.migration.lock"
SECONDS=0
! "$ROOT/bin/pi-fleet-state-migrate" --apply >/dev/null 2>&1
[[ "$SECONDS" -le 7 ]]
rmdir "$PI_FLEET_HOME/state/migrations/.migration.lock"

# Rollback rejects manifest symlinks, lexical traversal, dot components, and physical escapes.
cp "$manifest" "$TMP/good-manifest"
rm "$manifest"
ln -s "$TMP/good-manifest" "$manifest"
! "$ROOT/bin/pi-fleet-state-migrate" --rollback >/dev/null 2>&1
rm "$manifest"
cp "$TMP/good-manifest" "$manifest"
chmod 600 "$manifest"
for bad in "$PI_FLEET_HOME/../escaped" "$PI_FLEET_HOME/./dot" "$PI_FLEET_HOME/state/../escaped"; do
	python3 - "$manifest" "$bad" <<'PY'
import json,sys
json.dump({"version":1,"created":[{"source":"legacy","destination":sys.argv[2],"sha256":"0"*64}]},open(sys.argv[1],"w"))
PY
	! "$ROOT/bin/pi-fleet-state-migrate" --rollback >/dev/null 2>&1
done
mkdir -p "$TMP/outside" "$PI_FLEET_HOME/archive"
rm -rf "$PI_FLEET_HOME/archive/legacy-root"
ln -s "$TMP/outside" "$PI_FLEET_HOME/archive/legacy-root"
python3 - "$manifest" "$PI_FLEET_HOME/archive/legacy-root/escape" <<'PY'
import json,sys
json.dump({"version":1,"created":[{"source":"legacy","destination":sys.argv[2],"sha256":"0"*64}]},open(sys.argv[1],"w"))
PY
! "$ROOT/bin/pi-fleet-state-migrate" --rollback >/dev/null 2>&1
rm "$PI_FLEET_HOME/archive/legacy-root"
cp "$TMP/good-manifest" "$manifest"

# Rollback preserves modified destinations and removes unchanged migration-created files only.
printf 'changed\n' >"$PI_FLEET_HOME/state/e2b/jobs/legacy.json"
"$ROOT/bin/pi-fleet-state-migrate" --rollback >/dev/null
[[ "$(cat "$PI_FLEET_HOME/state/e2b/jobs/legacy.json")" == changed ]]
[[ ! -e "$PI_FLEET_HOME/state/e2b/jobs/loose.json" ]]
[[ ! -e "$PI_FLEET_HOME/archive/legacy-root/note.txt" ]]
[[ -e "$HOME/.pi/fleet/jobs/legacy.json" && -e "$HOME/.pi/fleet/secrets.env" ]]
[[ -e "$PI_FLEET_HOME/note.txt" && -e "$PI_FLEET_HOME/conflict-note.txt" && -e "$PI_FLEET_HOME/notes/subdir/item.txt" ]]

PI_FLEET_HOME=relative bash -c '. "$1/bin/lib/runtime-state.sh"; pi_fleet_runtime_root' _ "$ROOT" >/dev/null 2>&1 && exit 1
mkdir "$TMP/real-root"
ln -s "$TMP/real-root" "$TMP/link-root"
[[ "$(PI_FLEET_HOME="$TMP/link-root" bash -c '. "$1/bin/lib/runtime-state.sh"; pi_fleet_runtime_root' _ "$ROOT")" == "$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$TMP/real-root")" ]]
PI_FLEET_HOME="$TMP/link-root" "$ROOT/bin/pi-fleet-state-migrate" >/dev/null 2>&1 && exit 1
[[ "$(PI_FLEET_HOME="$TMP/custom" bash -c '. "$1/bin/lib/runtime-state.sh"; pi_fleet_runtime_root' _ "$ROOT")" == "$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$TMP/custom")" ]]
mkdir -p "$TMP/physical-parent/fleet/state"
ln -s "$TMP/physical-parent" "$TMP/ancestor-link"
PI_FLEET_HOME="$TMP/ancestor-link/fleet" bash -c '. "$1/bin/lib/runtime-state.sh"; pi_fleet_runtime_path state' _ "$ROOT" >/dev/null
PI_FLEET_HOME="$TMP/ancestor-link/fleet" "$ROOT/bin/pi-fleet-state-migrate" >/dev/null
ln -s "$TMP/outside" "$TMP/physical-parent/fleet/state/nested"
! PI_FLEET_HOME="$TMP/ancestor-link/fleet" bash -c '. "$1/bin/lib/runtime-state.sh"; pi_fleet_runtime_path state nested child' _ "$ROOT" >/dev/null 2>&1
echo 'ok - runtime root and non-destructive migration contract'
