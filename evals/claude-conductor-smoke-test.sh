#!/usr/bin/env bash
# claude-conductor-smoke-test — proves bin/claude-conductor's command shape, CONDUCTOR_NAME
# override, FLEET_YOLO gate, and arg forwarding, plus the executable bit. No real `claude` binary
# needed: a mock dropped in a temp PATH dir just echoes its argv (one per line) so we can assert on
# exactly what the wrapper execs.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WRAPPER="$DIR/bin/claude-conductor"
FAKE_BIN="$(mktemp -d)"
trap 'rm -rf "$FAKE_BIN"' EXIT

cat > "$FAKE_BIN/claude" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$@"
EOF
chmod +x "$FAKE_BIN/claude"

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

# Ambient fleet sessions often export FLEET_YOLO=1/CONDUCTOR_NAME themselves — unset both in every
# subshell below so the "default" cases genuinely exercise the wrapper's own defaults.
out=$(env -u FLEET_YOLO -u CONDUCTOR_NAME PATH="$FAKE_BIN:$PATH" "$WRAPPER")
check "default remote-control name" "$(printf -- '--remote-control\nclaude-conductor')" "$out"

out=$(env -u FLEET_YOLO CONDUCTOR_NAME="my-session" PATH="$FAKE_BIN:$PATH" "$WRAPPER")
check "CONDUCTOR_NAME override" "$(printf -- '--remote-control\nmy-session')" "$out"

out=$(env -u FLEET_YOLO -u CONDUCTOR_NAME PATH="$FAKE_BIN:$PATH" "$WRAPPER")
if printf '%s' "$out" | grep -q -- "--dangerously-skip-permissions"; then
  echo "FAIL: YOLO flag present without FLEET_YOLO=1"; fail=$((fail + 1))
else
  echo "PASS: YOLO flag absent by default"; pass=$((pass + 1))
fi

out=$(env -u CONDUCTOR_NAME FLEET_YOLO=1 PATH="$FAKE_BIN:$PATH" "$WRAPPER")
check "FLEET_YOLO=1 adds --dangerously-skip-permissions" \
  "$(printf -- '--remote-control\nclaude-conductor\n--dangerously-skip-permissions')" "$out"

out=$(env -u FLEET_YOLO -u CONDUCTOR_NAME PATH="$FAKE_BIN:$PATH" "$WRAPPER" --extra flag value)
check "extra args forwarded after --remote-control" \
  "$(printf -- '--remote-control\nclaude-conductor\n--extra\nflag\nvalue')" "$out"

echo "---"
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
