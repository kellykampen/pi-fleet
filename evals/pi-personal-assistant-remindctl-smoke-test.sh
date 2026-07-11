#!/usr/bin/env bash
# pi-personal-assistant-remindctl-smoke-test — FLT-17 regression guard.
#
# Proves the personal-assistant profile/skill accurately document `remindctl` (macOS Reminders)
# and that the expected binary/version is present, WITHOUT requiring Reminders permission to be
# granted and WITHOUT creating/completing/deleting any real reminder. It checks tool presence +
# version, and greps profile.yml/SKILL.md for the text contract: the expected version string, the
# permission prerequisite, and the hard write-gate language covering all reminder writes.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROFILE="$DIR/profiles/personal-assistant/profile.yml"
SKILL="$DIR/skills/personal-assistant/SKILL.md"
REMINDCTL_BIN="/opt/homebrew/bin/remindctl"
EXPECTED_VERSION="0.3.2"

pass=0; fail=0
check() {
  local desc="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then
    echo "PASS: $desc"; pass=$((pass + 1))
  else
    echo "FAIL: $desc"
    echo "  expected: $(printf '%q' "$expected")"
    echo "  actual:   $(printf '%q' "$actual")"
    fail=$((fail + 1))
  fi
}

check_grep() {
  local desc="$1" file="$2" pattern="$3"
  if grep -qE "$pattern" "$file"; then
    echo "PASS: $desc"; pass=$((pass + 1))
  else
    echo "FAIL: $desc (pattern not found in $file: $pattern)"; fail=$((fail + 1))
  fi
}

# --- Tool presence / version (skipped, not failed, if remindctl isn't installed on this machine —
# the profile/skill text contract below is still fully checkable without the real binary). ---
if [ -x "$REMINDCTL_BIN" ]; then
  echo "PASS: $REMINDCTL_BIN is present and executable"; pass=$((pass + 1))

  actual_version="$("$REMINDCTL_BIN" --version 2>&1 | tr -d '[:space:]')"
  actual_version="${actual_version#v}"
  check "remindctl --version reports expected version" "$EXPECTED_VERSION" "$actual_version"

  if "$REMINDCTL_BIN" status >/dev/null 2>&1; then
    echo "PASS: remindctl status ran without error (permission grant not required for this check)"
    pass=$((pass + 1))
  else
    echo "FAIL: remindctl status exited non-zero — remindctl binary is broken, not just unauthorized"
    fail=$((fail + 1))
  fi
else
  echo "SKIP: $REMINDCTL_BIN not found on this machine — install it (expected v$EXPECTED_VERSION) to exercise this check"
fi

# --- Profile text contract ---
check_grep "profile.yml documents remindctl" "$PROFILE" 'remindctl'
check_grep "profile.yml states expected version v0.3.2" "$PROFILE" 'v0\.3\.2'
check_grep "profile.yml documents the Reminders permission prerequisite" "$PROFILE" 'System Settings'
check_grep "profile.yml applies the hard write gate to reminder writes" "$PROFILE" \
  "explicit per-item approval"

# --- Skill text contract ---
check_grep "SKILL.md documents remindctl in the toolkit" "$SKILL" 'remindctl'
check_grep "SKILL.md states expected version v0.3.2" "$SKILL" 'v0\.3\.2'
check_grep "SKILL.md documents the Reminders permission prerequisite" "$SKILL" 'System Settings'
for cmd in show add complete delete; do
  check_grep "SKILL.md enumerates real remindctl command \`$cmd\`" "$SKILL" "\`$cmd\`"
done
check_grep "SKILL.md documents reads running directly without approval" "$SKILL" \
  'Reads run directly'
check_grep "SKILL.md applies the hard write gate to all reminder writes" "$SKILL" \
  'ALL writes need the same hard rule'
check_grep "SKILL.md warns against inventing reminder data" "$SKILL" 'Never invent reminder data'

echo "---"
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
