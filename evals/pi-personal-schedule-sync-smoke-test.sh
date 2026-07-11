#!/usr/bin/env bash
# Smoke test for bin/pi-personal-schedule-sync (FLT-24): asserts
#   1) first run creates both plists with the right Minute (Hour omitted = launchd's "every hour",
#      matching cron's "*" hour field) + preserved cron string,
#   2) second run is a true no-op (files untouched, byte-identical, no duplicate jobs),
#   3) editing schedules.json (changing cron) triggers a real update on the third run, still no dup.
# Runs against an isolated fake LaunchAgents/Logs dir + a fake schedules.json - never touches the
# real machine's launchd state or the repo's own schedules.json.
# PI_SCHEDULE_SYNC_DRY_RUN=1 skips real launchctl calls.
set -euo pipefail

FLEET_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

FAKE_AGENTS_DIR="$TMPDIR/LaunchAgents"
FAKE_LOG_DIR="$TMPDIR/Logs"
FAKE_SCHEDULES="$TMPDIR/schedules.json"
cp "$FLEET_ROOT/profiles/personal-assistant/schedules.json" "$FAKE_SCHEDULES"

pass=0
fail=0
check() {
  # check <bool: "true"|"false"> <message>
  if [[ "$1" == "true" ]]; then
    echo "  ok - $2"
    pass=$((pass + 1))
  else
    echo "  FAIL - $2"
    fail=$((fail + 1))
  fi
}
check_eq() {
  # check_eq <actual> <expected> <message>
  if [[ "$1" == "$2" ]]; then
    echo "  ok - $3 (got '$1')"
    pass=$((pass + 1))
  else
    echo "  FAIL - $3 (expected '$2', got '$1')"
    fail=$((fail + 1))
  fi
}
plist_count() {
  shopt -s nullglob
  local plists=("$FAKE_AGENTS_DIR"/*.plist)
  shopt -u nullglob
  echo "${#plists[@]}"
}

run_sync() {
  PI_SCHEDULE_SYNC_AGENTS_DIR="$FAKE_AGENTS_DIR" \
  PI_SCHEDULE_SYNC_LOG_DIR="$FAKE_LOG_DIR" \
  PI_SCHEDULE_SYNC_SCHEDULES_JSON="$FAKE_SCHEDULES" \
  PI_SCHEDULE_SYNC_DRY_RUN=1 \
  "$FLEET_ROOT/bin/pi-personal-schedule-sync"
}

echo "1) first run: creates both plists"
run_sync
SOCIAL_PLIST="$FAKE_AGENTS_DIR/dev.pi-fleet.personal.social-x-checkup.plist"
GMAIL_PLIST="$FAKE_AGENTS_DIR/dev.pi-fleet.personal.gmail-reply-checkup.plist"
[[ -f "$SOCIAL_PLIST" ]] && check true "social-x-checkup plist created" || check false "social-x-checkup plist created"
[[ -f "$GMAIL_PLIST" ]] && check true "gmail-reply-checkup plist created" || check false "gmail-reply-checkup plist created"

SOCIAL_MINUTE="$(plutil -extract StartCalendarInterval.Minute raw "$SOCIAL_PLIST" 2>/dev/null || echo MISSING)"
check_eq "$SOCIAL_MINUTE" "0" "social-x-checkup Minute == 0 (top of every hour)"

SOCIAL_HOUR="$(plutil -extract StartCalendarInterval.Hour raw "$SOCIAL_PLIST" 2>/dev/null || echo MISSING)"
check_eq "$SOCIAL_HOUR" "MISSING" "social-x-checkup Hour key omitted (cron '*' hour = every hour in launchd)"

GMAIL_MINUTE="$(plutil -extract StartCalendarInterval.Minute raw "$GMAIL_PLIST" 2>/dev/null || echo MISSING)"
check_eq "$GMAIL_MINUTE" "5" "gmail-reply-checkup Minute == 5 (five past every hour)"

CRON_ORIGINAL="$(plutil -extract PiFleetCronOriginal raw "$SOCIAL_PLIST" 2>/dev/null || echo MISSING)"
check_eq "$CRON_ORIGINAL" "0 0 * * * *" "PiFleetCronOriginal preserved exactly"

echo "2) second run: true no-op (byte-identical, no duplicate jobs)"
BEFORE_SUM="$(shasum "$SOCIAL_PLIST" "$GMAIL_PLIST")"
run_sync
AFTER_SUM="$(shasum "$SOCIAL_PLIST" "$GMAIL_PLIST")"
[[ "$BEFORE_SUM" == "$AFTER_SUM" ]] && check true "second run is byte-identical (idempotent)" || check false "second run is byte-identical (idempotent)"
check_eq "$(plist_count)" "2" "still exactly 2 plists after second run"

echo "3) editing schedules.json triggers a real update, not a duplicate"
python3 -c "
import json
p = '$FAKE_SCHEDULES'
d = json.load(open(p))
d['schedules'][0]['cron'] = '0 30 * * * *'
json.dump(d, open(p, 'w'))
"
run_sync
NEW_MINUTE="$(plutil -extract StartCalendarInterval.Minute raw "$SOCIAL_PLIST" 2>/dev/null || echo MISSING)"
check_eq "$NEW_MINUTE" "30" "updated cron reflected after edit"
check_eq "$(plist_count)" "2" "still exactly 2 plists after update (no duplicate)"

echo ""
echo "pass=$pass fail=$fail"
[[ "$fail" -eq 0 ]]
