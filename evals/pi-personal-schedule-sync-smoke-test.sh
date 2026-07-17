#!/usr/bin/env bash
# Regression smoke test for the launchd-only personal scheduler (FLT-35).
# Runs entirely in a throwaway HOME: no real LaunchAgents, launchctl jobs, or global scheduler
# state are touched.
set -euo pipefail

FLEET_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

FAKE_HOME="$TMPDIR/home"
FAKE_AGENTS_DIR="$FAKE_HOME/Library/LaunchAgents"
FAKE_LOG_DIR="$FAKE_HOME/.pi-fleet/logs/personal"
FAKE_SCHEDULES="$TMPDIR/schedules.json"
FAKE_BIN="$TMPDIR/bin"
STABLE_RUNNER="$FAKE_HOME/code/pi-fleet/bin/pi-personal-schedule-run"
GLOBAL_TASKS="$FAKE_HOME/.pi/agent/state/scheduler/tasks.json"
LAUNCHCTL_LOG="$TMPDIR/launchctl.log"
mkdir -p "$FAKE_BIN" "$(dirname "$STABLE_RUNNER")" "$(dirname "$GLOBAL_TASKS")"
cp "$FLEET_ROOT/profiles/personal-assistant/schedules.json" "$FAKE_SCHEDULES"
printf '#!/usr/bin/env bash\nexit 0\n' >"$STABLE_RUNNER"
printf '#!/usr/bin/env bash\nexit 0\n' >"$FAKE_BIN/outfitter"
cat >"$FAKE_BIN/launchctl" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$PI_TEST_LAUNCHCTL_LOG"
exit 0
EOF
chmod +x "$STABLE_RUNNER" "$FAKE_BIN/outfitter" "$FAKE_BIN/launchctl"
printf '{"version":2,"tasks":[]}\n' >"$GLOBAL_TASKS"

pass=0
fail=0
check() {
	if [[ "$1" == "true" ]]; then
		echo "  ok - $2"
		pass=$((pass + 1))
	else
		echo "  FAIL - $2"
		fail=$((fail + 1))
	fi
}
check_eq() {
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
	HOME="$FAKE_HOME" \
		PATH="$FAKE_BIN:/usr/bin:/bin:/usr/sbin:/sbin" \
		PI_FLEET_PROFILE=personal-assistant \
		PI_SCHEDULE_SYNC_AGENTS_DIR="$FAKE_AGENTS_DIR" \
		PI_SCHEDULE_SYNC_LOG_MAX_BYTES=16 \
		PI_SCHEDULE_SYNC_SCHEDULES_JSON="$FAKE_SCHEDULES" \
		PI_SCHEDULER_TASKS_FILE="$GLOBAL_TASKS" \
		PI_TEST_LAUNCHCTL_LOG="$LAUNCHCTL_LOG" \
		"$FLEET_ROOT/bin/pi-personal-schedule-sync"
}

SOCIAL_PLIST="$FAKE_AGENTS_DIR/dev.pi-fleet.personal.social-x-checkup.plist"
GMAIL_PLIST="$FAKE_AGENTS_DIR/dev.pi-fleet.personal.gmail-reply-checkup.plist"

echo "1) profile guard: a non-personal role cannot install schedules"
HOME="$FAKE_HOME" PATH="$FAKE_BIN:/usr/bin:/bin" PI_FLEET_PROFILE=conductor \
	PI_SCHEDULE_SYNC_AGENTS_DIR="$FAKE_AGENTS_DIR" \
	PI_SCHEDULE_SYNC_SCHEDULES_JSON="$FAKE_SCHEDULES" \
	"$FLEET_ROOT/bin/pi-personal-schedule-sync" >/dev/null
check_eq "$(plist_count)" "0" "conductor invocation creates no personal schedules"

echo "2) first personal sync: creates and loads stable, launchd-safe jobs"
mkdir -p "$FAKE_LOG_DIR"
printf 'this log is deliberately oversized\n' >"$FAKE_LOG_DIR/social-x-checkup.log"
run_sync
[[ "$(stat -f '%Lp' "$FAKE_LOG_DIR")" == 700 ]] && check true "personal log directory is private" || check false "personal log directory is private"
[[ -f "$FAKE_LOG_DIR/social-x-checkup.log.1" ]] && check true "oversized personal log rotates" || check false "oversized personal log rotates"
[[ -f "$SOCIAL_PLIST" ]] && check true "social-x-checkup plist created" || check false "social-x-checkup plist created"
[[ -f "$GMAIL_PLIST" ]] && check true "gmail-reply-checkup plist created" || check false "gmail-reply-checkup plist created"
check_eq "$(plutil -extract ProgramArguments.0 raw "$SOCIAL_PLIST")" "$STABLE_RUNNER" "plist uses configured stable runner"
check_eq "$(plutil -extract EnvironmentVariables.PATH raw "$SOCIAL_PLIST")" "$FAKE_BIN:/usr/bin:/bin:/usr/sbin:/sbin" "plist carries executable PATH for launchd"
check_eq "$(plutil -extract StartCalendarInterval.Minute raw "$SOCIAL_PLIST")" "0" "social schedule fires at minute 0"
SOCIAL_HOUR="$(plutil -extract StartCalendarInterval.Hour raw "$SOCIAL_PLIST" 2>/dev/null || echo MISSING)"
check_eq "$SOCIAL_HOUR" "MISSING" "cron '*' hour is represented by an omitted Hour key"
check_eq "$(plutil -extract StartCalendarInterval.Minute raw "$GMAIL_PLIST")" "5" "gmail schedule fires at minute 5"
check_eq "$(grep -c '^bootstrap ' "$LAUNCHCTL_LOG" || true)" "2" "both launchd jobs bootstrapped"

TASKS_BEFORE="$(cat "$GLOBAL_TASKS")"
check_eq "$(python3 -c 'import json,sys; print(len(json.load(open(sys.argv[1]))["tasks"]))' "$GLOBAL_TASKS")" "0" "global pi scheduler starts empty"

echo "3) repeat sync: plist is byte-identical but failed/stale jobs are reloaded"
BEFORE_SUM="$(shasum "$SOCIAL_PLIST" "$GMAIL_PLIST")"
run_sync
AFTER_SUM="$(shasum "$SOCIAL_PLIST" "$GMAIL_PLIST")"
[[ "$BEFORE_SUM" == "$AFTER_SUM" ]] && check true "repeat sync leaves plist bytes unchanged" || check false "repeat sync leaves plist bytes unchanged"
check_eq "$(grep -c '^bootstrap ' "$LAUNCHCTL_LOG" || true)" "4" "repeat sync reloads both jobs"
check_eq "$(plist_count)" "2" "repeat sync creates no duplicate plists"
check_eq "$(cat "$GLOBAL_TASKS")" "$TASKS_BEFORE" "personal sync leaves global scheduler store empty and unchanged"

echo "4) PI_SCHEDULE_SYNC_ENABLED=0 unloads and removes installed schedules"
HOME="$FAKE_HOME" PATH="$FAKE_BIN:/usr/bin:/bin" PI_FLEET_PROFILE=personal-assistant \
	PI_SCHEDULE_SYNC_ENABLED=0 \
	PI_SCHEDULE_SYNC_AGENTS_DIR="$FAKE_AGENTS_DIR" \
	PI_TEST_LAUNCHCTL_LOG="$LAUNCHCTL_LOG" \
	"$FLEET_ROOT/bin/pi-personal-schedule-sync" >/dev/null
check_eq "$(plist_count)" "0" "disabled sync removes both personal LaunchAgents"
check_eq "$(cat "$GLOBAL_TASKS")" "$TASKS_BEFORE" "disabled sync does not populate global scheduler store"

echo "5) PI_SCHEDULE_SYNC_ENABLED=0 with zero installed plists does not crash (bash 3.2 unbound-array regression)"
DISABLE_AGAIN_STATUS=0
/bin/bash -c '
HOME="$1" PATH="$2:/usr/bin:/bin" PI_FLEET_PROFILE=personal-assistant \
	PI_SCHEDULE_SYNC_ENABLED=0 \
	PI_SCHEDULE_SYNC_AGENTS_DIR="$3" \
	PI_TEST_LAUNCHCTL_LOG="$4" \
	"$5/bin/pi-personal-schedule-sync"
' _ "$FAKE_HOME" "$FAKE_BIN" "$FAKE_AGENTS_DIR" "$LAUNCHCTL_LOG" "$FLEET_ROOT" >/dev/null 2>&1 || DISABLE_AGAIN_STATUS=$?
check_eq "$DISABLE_AGAIN_STATUS" "0" "disabling an already-empty schedule set exits 0 on stock /bin/bash instead of crashing on unbound \${plists[@]}"
check_eq "$(plist_count)" "0" "still zero plists after disabling an already-empty set"

echo ""
echo "pass=$pass fail=$fail"
[[ "$fail" -eq 0 ]]
