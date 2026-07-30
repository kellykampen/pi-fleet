#!/usr/bin/env bash
# Deterministic launch-boundary smoke for the isolated Pi project-lead policy overlay.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FAKE_BIN="$(mktemp -d)"
FAKE_HOME="$(mktemp -d)"
CALLER="$(mktemp -d)"
RUNTIME="$(mktemp -d)"
trap 'rm -rf "$FAKE_BIN" "$FAKE_HOME" "$CALLER" "$RUNTIME"' EXIT
SOURCE_AGENT="$FAKE_HOME/source-agent"
mkdir -p "$SOURCE_AGENT/npm/node_modules/@gotgenes/pi-permission-system"
printf '{}\n' > "$SOURCE_AGENT/auth.json"
mkdir -p "$CALLER/.pi/extensions/pi-permission-system"
cat > "$CALLER/.pi/extensions/pi-permission-system/config.json" <<'EOF'
{"permission":{"*":"allow","bash":{"*":"allow"}}}
EOF

cat > "$FAKE_BIN/outfitter" <<'EOF'
#!/usr/bin/env bash
printf 'CWD=%s\n' "$(pwd -P)"
printf 'PI_CODING_AGENT_DIR=%s\n' "${PI_CODING_AGENT_DIR-}"
printf 'FLEET_COORDINATION_ROOT=%s\n' "${FLEET_COORDINATION_ROOT-}"
printf 'PATH=%s\n' "$PATH"
printf 'ARG=%s\n' "$@"
EOF
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

out=$(cd "$CALLER" && env PI_CODING_AGENT_DIR="$SOURCE_AGENT" FLEET_PROJECT_LEAD_RUNTIME_DIR="$RUNTIME" \
  PATH="$FAKE_BIN:$PATH" "$DIR/bin/pi-project-lead" --print hi)
contains "Pi runs from dedicated policy cwd" "CWD=$(cd "$RUNTIME/policy-cwd" && pwd -P)" "$out"
contains "isolated agent overlay exported" "PI_CODING_AGENT_DIR=$RUNTIME/agent" "$out"
contains "caller retained as coordination root" "FLEET_COORDINATION_ROOT=$(cd "$CALLER" && pwd -P)" "$out"
contains "permission package explicitly loaded" "ARG=$SOURCE_AGENT/npm/node_modules/@gotgenes/pi-permission-system" "$out"
contains "immutable project-lead policy extension loaded" "ARG=$DIR/extensions/project-lead-policy.ts" "$out"
contains "linear extension still loaded" "ARG=$DIR/extensions/linear.ts" "$out"
contains "e2b extension still loaded" "ARG=$DIR/extensions/e2b" "$out"
contains "fleet-note directory is prepended to PATH" "PATH=$DIR/bin:$FAKE_BIN:$PATH" "$out"
contains "restricted tool list" "ARG=read,grep,find,ls,bash,linear_get_issue,linear_list,linear_comment,linear_update,e2b_cast,e2b_status,e2b_wait,e2b_cancel,e2b_logs,e2b_port_url" "$out"
rejects "write/edit are absent from tool list" '^ARG=.*(write|edit)' "$out"

for config in \
  "$RUNTIME/agent/extensions/pi-permission-system/config.json" \
  "$RUNTIME/policy-cwd/.pi/extensions/pi-permission-system/config.json"; do
  if [ -L "$config" ] && [ "$(readlink "$config")" = "$DIR/permission-system/project-lead.json" ]; then
    ok "$config pins tracked project-lead policy"
  else
    no "$config pins tracked project-lead policy"
  fi
done
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

# Outfitter-launched callers may carry an isolated PI_CODING_AGENT_DIR that has auth but not the
# globally installed package. The wrapper must find the package in the default agent dir without
# abandoning the caller's auth source.
rmdir "$SOURCE_AGENT/npm/node_modules/@gotgenes/pi-permission-system"
DEFAULT_PACKAGE="$FAKE_HOME/.pi/agent/npm/node_modules/@gotgenes/pi-permission-system"
FALLBACK_RUNTIME="$FAKE_HOME/fallback-runtime"
mkdir -p "$DEFAULT_PACKAGE"
out=$(cd "$CALLER" && env HOME="$FAKE_HOME" PI_CODING_AGENT_DIR="$SOURCE_AGENT" \
  FLEET_PROJECT_LEAD_RUNTIME_DIR="$FALLBACK_RUNTIME" PATH="$FAKE_BIN:$PATH" \
  "$DIR/bin/pi-project-lead" --print hi)
contains "package lookup falls back to the default agent dir" "ARG=$DEFAULT_PACKAGE" "$out"
if [ -L "$FALLBACK_RUNTIME/agent/auth.json" ] && [ "$(readlink "$FALLBACK_RUNTIME/agent/auth.json")" = "$SOURCE_AGENT/auth.json" ]; then
  ok "package fallback still preserves caller auth source"
else
  no "package fallback still preserves caller auth source"
fi

echo "---"
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
