#!/usr/bin/env bash
# Deterministic launch-boundary smoke for the isolated Pi project-lead overlay (FLT-67: no PS).
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
mkdir -p "$CALLER/.pi/extensions/pi-permission-system"
cat > "$CALLER/.pi/extensions/pi-permission-system/config.json" <<'CFG'
{"permission":{"*":"allow","bash":{"*":"allow"}}}
CFG

cat > "$FAKE_BIN/outfitter" <<'EOFMOCK'
#!/usr/bin/env bash
printf 'CWD=%s\n' "$(pwd -P)"
printf 'PI_CODING_AGENT_DIR=%s\n' "${PI_CODING_AGENT_DIR-}"
printf 'FLEET_COORDINATION_ROOT=%s\n' "${FLEET_COORDINATION_ROOT-}"
printf 'FLEET_WORKSPACE_SLUG=%s\n' "${FLEET_WORKSPACE_SLUG-}"
printf 'FLEET_LEAD_MAILBOX=%s\n' "${FLEET_LEAD_MAILBOX-}"
printf 'FLEET_ALLOWED_REPO_ROOTS=%s\n' "${FLEET_ALLOWED_REPO_ROOTS-}"
printf 'FLEET_WORKSPACES_PATH=%s\n' "${FLEET_WORKSPACES_PATH-}"
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

# FLT-69: launch from a path that basename-matches pi-fleet default, with isolated PI_FLEET_HOME.
FLEET_HOME="$FAKE_HOME/.pi-fleet"
mkdir -p "$CALLER/pi-fleet-checkout"
# Prefer explicit slug so resolve does not depend on git remotes in the temp tree.
out=$(cd "$CALLER" && env PI_CODING_AGENT_DIR="$SOURCE_AGENT" FLEET_PROJECT_LEAD_RUNTIME_DIR="$RUNTIME" \
  PI_FLEET_HOME="$FLEET_HOME" FLEET_WORKSPACE_SLUG=pi-fleet \
  PATH="$FAKE_BIN:$PATH" "$DIR/bin/pi-project-lead" --print hi)
contains "Pi runs from dedicated policy cwd" "CWD=$(cd "$RUNTIME/policy-cwd" && pwd -P)" "$out"
contains "isolated agent overlay exported" "PI_CODING_AGENT_DIR=$RUNTIME/agent" "$out"
contains "caller retained as coordination root" "FLEET_COORDINATION_ROOT=$(cd "$CALLER" && pwd -P)" "$out"
contains "always YOLO --approve" "ARG=--approve" "$out"
contains "immutable project-lead policy extension loaded" "ARG=$DIR/extensions/project-lead-policy.ts" "$out"
contains "linear extension still loaded" "ARG=$DIR/extensions/linear.ts" "$out"
contains "e2b extension still loaded" "ARG=$DIR/extensions/e2b" "$out"
contains "fleet-note directory is prepended to PATH" "PATH=$DIR/bin:$FAKE_BIN:$PATH" "$out"
contains "restricted tool list" "ARG=read,grep,find,ls,bash,linear_get_issue,linear_list,linear_comment,linear_update,e2b_cast,e2b_status,e2b_wait,e2b_cancel,e2b_logs,e2b_port_url" "$out"
rejects "write/edit are absent from tool list" '^ARG=.*(write|edit)' "$out"
rejects "permission-system is NOT loaded" 'pi-permission-system|@gotgenes/pi-permission-system|PI_PERMISSION_SYSTEM' "$out"
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
contains "workspace slug derived from registry" "FLEET_WORKSPACE_SLUG=pi-fleet" "$out"
contains "lead mailbox aligned to <workspace>-project-lead" "FLEET_LEAD_MAILBOX=pi-fleet-project-lead" "$out"
if printf '%s\n' "$out" | grep -Eq '^FLEET_ALLOWED_REPO_ROOTS=.+'; then
  ok "allowed repo roots exported for worker inheritance"
else
  no "allowed repo roots exported for worker inheritance"
fi
if printf '%s\n' "$out" | grep -Fq "FLEET_WORKSPACES_PATH=$FLEET_HOME/workspaces.json" \
  || printf '%s\n' "$out" | grep -Eq '^FLEET_WORKSPACES_PATH=.+/workspaces\.json$'; then
  ok "workspaces.json path exported"
else
  no "workspaces.json path exported"
fi
if [ -f "$FLEET_HOME/workspaces.json" ]; then
  ok "workspaces.json seeded under PI_FLEET_HOME"
else
  no "workspaces.json seeded under PI_FLEET_HOME"
fi

echo "---"
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
