#!/usr/bin/env bash
# pi-project-lead-extension-path-smoke-test — FLT-15 regression guard.
#
# outfitter/pi resolve profile.yml's relative `extensions:` paths (e.g. `../extensions/linear.ts`)
# against the *launching process's cwd*, not against profile.yml's own location — unlike `skills:`,
# which outfitter anchors to the configured profile source root regardless of cwd. That meant
# bin/pi-project-lead failed with "Failed to load extension ... /Users/<x>/code/extensions/linear.ts"
# whenever invoked from anywhere other than one specific directory (including the documented "cd to
# your project, then run the wrapper" launch pattern from the repo's own README).
#
# The fix: bin/pi-project-lead resolves FLEET_ROOT from its own script location and passes
# --extension as an absolute path; profiles/project-lead/profile.yml no longer declares extensions.
# This proves both halves hold, without needing a real `outfitter`/`pi` binary, network access, or
# provider auth: a mock `outfitter` dropped in a temp PATH dir just echoes its argv, and we assert
# the --extension values are absolute, exist on disk, and are cwd-independent.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WRAPPER="$DIR/bin/pi-project-lead"
FAKE_BIN="$(mktemp -d)"
trap 'rm -rf "$FAKE_BIN"' EXIT

cat > "$FAKE_BIN/outfitter" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$@"
EOF
chmod +x "$FAKE_BIN/outfitter"

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

if [ -x "$WRAPPER" ]; then
  echo "PASS: wrapper is executable"; pass=$((pass + 1))
else
  echo "FAIL: wrapper is not executable"; fail=$((fail + 1))
fi

if grep -q '^\s*extensions:' "$DIR/profiles/project-lead/profile.yml"; then
  echo "FAIL: profiles/project-lead/profile.yml declares extensions: (cwd-relative, breaks per FLT-15)"
  fail=$((fail + 1))
else
  echo "PASS: profiles/project-lead/profile.yml does not declare cwd-relative extensions"
  pass=$((pass + 1))
fi

extract_extension_args() {
  # Extension flag values immediately follow "--extension" in the mocked argv dump.
  awk '/^--extension$/ { getline; print }'
}

run_from() {
  (cd "$1" && env -u FLEET_YOLO -u E2B_API_KEY -u FLEET_GITHUB_TOKEN HOME="$2" \
    PATH="$FAKE_BIN:$PATH" "$WRAPPER" --print "hi")
}

# Isolated fake HOME with no secrets.env, so the wrapper's optional source is a no-op.
FAKE_HOME="$(mktemp -d)"
trap 'rm -rf "$FAKE_BIN" "$FAKE_HOME"' EXIT

for cwd in "$DIR" "$HOME" /tmp; do
  out="$(run_from "$cwd" "$FAKE_HOME")"
  extensions="$(printf '%s\n' "$out" | extract_extension_args)"

  linear_path="$(printf '%s\n' "$extensions" | sed -n '1p')"
  e2b_path="$(printf '%s\n' "$extensions" | sed -n '2p')"

  check "linear.ts extension path is absolute (launched from $cwd)" \
    "$DIR/extensions/linear.ts" "$linear_path"
  check "e2b extension path is absolute (launched from $cwd)" \
    "$DIR/extensions/e2b" "$e2b_path"

  if [ -e "$linear_path" ]; then
    echo "PASS: resolved linear.ts extension path exists on disk"; pass=$((pass + 1))
  else
    echo "FAIL: resolved linear.ts extension path does not exist: $linear_path"; fail=$((fail + 1))
  fi
  if [ -e "$e2b_path" ]; then
    echo "PASS: resolved e2b extension path exists on disk"; pass=$((pass + 1))
  else
    echo "FAIL: resolved e2b extension path does not exist: $e2b_path"; fail=$((fail + 1))
  fi
done

echo "---"
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
