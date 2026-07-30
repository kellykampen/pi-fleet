#!/usr/bin/env bash
# Prove fleet wrappers strip caller attempts to override --approve/--tools/--no-extensions/--extension.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FAKE_BIN="$(mktemp -d)"
trap 'rm -rf "$FAKE_BIN"' EXIT

cat >"$FAKE_BIN/outfitter" <<'MOCK'
#!/usr/bin/env bash
printf 'ARG=%s\n' "$@"
MOCK
chmod +x "$FAKE_BIN/outfitter"

# Minimal package stubs for seats that resolve optional extensions.
mkdir -p "$FAKE_BIN/agent/npm/node_modules/pi-subagents"
printf '{}\n' >"$FAKE_BIN/agent/npm/node_modules/pi-subagents/package.json"
printf '// mock\n' >"$FAKE_BIN/agent/npm/node_modules/pi-subagents/index.ts"
mkdir -p "$FAKE_BIN/agent/npm/node_modules/pi-xai-oauth/extensions"
touch "$FAKE_BIN/agent/npm/node_modules/pi-xai-oauth/extensions/xai-oauth.ts"
mkdir -p "$FAKE_BIN/agent/npm/node_modules/pi-provider-kimi-code"
touch "$FAKE_BIN/agent/npm/node_modules/pi-provider-kimi-code/index.ts"

pass=0
fail=0
ok() { echo "PASS: $1"; pass=$((pass + 1)); }
no() { echo "FAIL: $1"; fail=$((fail + 1)); }

run_wrapper() {
  local wrapper="$1"; shift
  cd /tmp && env PATH="$FAKE_BIN:$PATH" \
    PI_CODING_AGENT_DIR="$FAKE_BIN/agent" HOME="$FAKE_BIN" \
    FLEET_PROJECT_LEAD_RUNTIME_DIR="$FAKE_BIN/lead-runtime" \
    FLEET_CONDUCTOR_RUNTIME_DIR="$FAKE_BIN/cond-runtime" \
    FLEET_IMPLEMENTER_RUNTIME_DIR="$FAKE_BIN/impl-runtime" \
    PI_XAI_OAUTH_EXT="$FAKE_BIN/agent/npm/node_modules/pi-xai-oauth/extensions/xai-oauth.ts" \
    PI_KIMI_CODE_EXT="$FAKE_BIN/agent/npm/node_modules/pi-provider-kimi-code/index.ts" \
    "$DIR/bin/$wrapper" "$@"
}

assert_last_tools() {
  local desc="$1" expected="$2" out="$3"
  local last
  last="$(printf '%s\n' "$out" | grep -E '^ARG=read,|^ARG=bash,' | tail -1 | sed 's/^ARG=//')"
  if [ "$last" = "$expected" ]; then ok "$desc"
  else no "$desc (got tools='$last' expected='$expected')"; fi
}

assert_has_approve() {
  local desc="$1" out="$2"
  if printf '%s\n' "$out" | grep -Fqx 'ARG=--approve'; then ok "$desc"
  else no "$desc"; fi
}

assert_no_rogue_tools_value() {
  local desc="$1" out="$2"
  if printf '%s\n' "$out" | grep -Fqx 'ARG=write,edit,bash'; then no "$desc (rogue tools value present)"
  else ok "$desc"; fi
}

echo "wrapper arg sanitization smoke (FLT-67)"

# security-reviewer: caller tries to widen tools + drop approve
out="$(run_wrapper pi-security-reviewer --tools write,edit,bash --approve -p noop)"
assert_has_approve "security-reviewer keeps --approve against override attempt" "$out"
assert_last_tools "security-reviewer keeps read-only tools last" "read,grep,find,ls" "$out"
assert_no_rogue_tools_value "security-reviewer strips caller --tools write,edit,bash" "$out"

# planner: caller tries to strip policy extension and widen tools
out="$(run_wrapper pi-planner --tools write,edit,bash --no-extensions --extension /tmp/evil.ts -p noop)"
assert_has_approve "planner keeps --approve" "$out"
if printf '%s\n' "$out" | grep -Fqx "ARG=$DIR/extensions/planner-policy.ts"; then
  ok "planner still loads planner-policy extension"
else
  no "planner still loads planner-policy extension"
fi
if printf '%s\n' "$out" | grep -Fqx 'ARG=/tmp/evil.ts'; then
  no "planner strips caller --extension"
else
  ok "planner strips caller --extension"
fi
assert_no_rogue_tools_value "planner strips widened --tools" "$out"

# project-lead: caller tries to add write/edit
out="$(run_wrapper pi-project-lead --tools read,grep,find,ls,write,edit,bash -p noop)"
assert_has_approve "project-lead keeps --approve" "$out"
if printf '%s\n' "$out" | grep -E '^ARG=.*write' | grep -vq 'project-lead-policy\|linear\|e2b'; then
  # tools line must not include write/edit
  tools_line="$(printf '%s\n' "$out" | grep -E '^ARG=read,grep,find,ls,bash,' | tail -1)"
  if printf '%s\n' "$tools_line" | grep -Eq 'write|edit'; then
    no "project-lead tools remain without write/edit"
  else
    ok "project-lead tools remain without write/edit"
  fi
else
  tools_line="$(printf '%s\n' "$out" | grep -E '^ARG=read,grep,find,ls,bash,' | tail -1)"
  if printf '%s\n' "$tools_line" | grep -Eq 'write|edit'; then
    no "project-lead tools remain without write/edit ($tools_line)"
  else
    ok "project-lead tools remain without write/edit"
  fi
fi

# spike-breakdown policy extension survives override attempts
out="$(run_wrapper pi-spike-breakdown --tools write,edit,bash --extension /tmp/evil.ts -p noop)"
assert_has_approve "spike-breakdown keeps --approve" "$out"
if printf '%s\n' "$out" | grep -Fqx "ARG=$DIR/extensions/spike-breakdown-policy.ts"; then
  ok "spike-breakdown still loads spike-breakdown-policy"
else
  no "spike-breakdown still loads spike-breakdown-policy"
fi

echo "---"
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
