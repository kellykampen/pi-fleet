#!/usr/bin/env bash
# Deterministic launch-boundary smoke for the isolated Pi conductor overlay (FLT-67: no PS).
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FAKE_BIN="$(mktemp -d)"
FAKE_HOME="$(mktemp -d)"
CALLER="$(mktemp -d)"
RUNTIME="$(mktemp -d)"
trap 'rm -rf "$FAKE_BIN" "$FAKE_HOME" "$CALLER" "$RUNTIME"' EXIT
SOURCE_AGENT="$FAKE_HOME/source-agent"
mkdir -p "$SOURCE_AGENT"
printf '{}\n' > "$SOURCE_AGENT/auth.json"
# Caller may still have a leftover PS config — the seat must not load it.
mkdir -p "$CALLER/.pi/extensions/pi-permission-system"
cat > "$CALLER/.pi/extensions/pi-permission-system/config.json" <<'CFG'
{"permission":{"*":"allow","bash":{"*":"allow"}}}
CFG

cat > "$FAKE_BIN/outfitter" <<'EOFMOCK'
#!/usr/bin/env bash
printf 'CWD=%s\n' "$(pwd -P)"
printf 'PI_CODING_AGENT_DIR=%s\n' "${PI_CODING_AGENT_DIR-}"
printf 'FLEET_COORDINATION_ROOT=%s\n' "${FLEET_COORDINATION_ROOT-}"
printf 'PATH=%s\n' "$PATH"
printf 'ARG=%s\n' "$@"
EOFMOCK
chmod +x "$FAKE_BIN/outfitter"

pass=0; fail=0
ok() { echo "PASS: $1"; pass=$((pass + 1)); }
no() { echo "FAIL: $1"; fail=$((fail + 1)); }
contains() {
  local desc="$1" expected="$2" output="$3"
  if printf '%s\n' "$output" | grep -Fqx -- "$expected"; then ok "$desc"; else no "$desc (missing: $expected)"; fi
}
rejects() {
  local desc="$1" pattern="$2" output="$3"
  if printf '%s\n' "$output" | grep -Eq -- "$pattern"; then no "$desc"; else ok "$desc"; fi
}

out=$(cd "$CALLER" && env PI_CODING_AGENT_DIR="$SOURCE_AGENT" FLEET_CONDUCTOR_RUNTIME_DIR="$RUNTIME" \
  PATH="$FAKE_BIN:$PATH" "$DIR/bin/pi-conductor" --print hi)
contains "Pi runs from dedicated policy cwd" "CWD=$(cd "$RUNTIME/policy-cwd" && pwd -P)" "$out"
contains "isolated agent overlay exported" "PI_CODING_AGENT_DIR=$RUNTIME/agent" "$out"
contains "caller retained as coordination root" "FLEET_COORDINATION_ROOT=$(cd "$CALLER" && pwd -P)" "$out"
contains "always YOLO --approve" "ARG=--approve" "$out"
contains "immutable conductor policy extension loaded" "ARG=$DIR/extensions/conductor-policy.ts" "$out"
contains "linear extension loaded" "ARG=$DIR/extensions/linear.ts" "$out"
contains "fleet-note directory is prepended to PATH" "PATH=$DIR/bin:$FAKE_BIN:$PATH" "$out"
contains "routing-only tool list (FLT-65)" "ARG=bash,linear_get_issue,linear_list,linear_comment,linear_update" "$out"
rejects "write/edit are absent from tool list" '^ARG=.*(write|edit)' "$out"
rejects "product investigation tools absent from tool list" '^ARG=.*(read|grep|find|,ls,)' "$out"
rejects "permission-system is NOT loaded" 'pi-permission-system|@gotgenes/pi-permission-system|PI_PERMISSION_SYSTEM' "$out"
# No PS config should be linked into the runtime overlay.
if [ ! -e "$RUNTIME/agent/extensions/pi-permission-system/config.json" ] \
  && [ ! -e "$RUNTIME/policy-cwd/.pi/extensions/pi-permission-system/config.json" ]; then
  ok "runtime does not install permission-system config overlay"
else
  no "runtime does not install permission-system config overlay"
fi
if [ -L "$RUNTIME/agent/auth.json" ] && [ "$(readlink "$RUNTIME/agent/auth.json")" = "$SOURCE_AGENT/auth.json" ]; then
  ok "isolated overlay preserves source auth by symlink"
else
  no "isolated overlay preserves source auth by symlink"
fi
if [ -L "$RUNTIME/policy-cwd/launch-cwd" ] && [ "$(readlink "$RUNTIME/policy-cwd/launch-cwd")" = "$(cd "$CALLER" && pwd -P)" ]; then
  ok "policy cwd exposes caller through a stable read target"
else
  no "policy cwd exposes caller through a stable read target"
fi

echo "---"
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
