#!/usr/bin/env bash
# setup-sh-smoke-test — proves setup.sh's --help/--check/unknown-arg behavior, that --check makes
# no changes (no bootstrap invocation, no installs), and that it correctly reports both "all
# present" and "things missing" states. Every external CLI is mocked in a fake PATH dir so this
# never touches the real machine or network, and HOME is redirected to a scratch dir so it never
# reads/writes the real ~/.pi/agent.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="$DIR/setup.sh"

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
check_contains() {
  local desc="$1" haystack="$2" needle="$3"
  if printf '%s' "$haystack" | grep -qF -- "$needle"; then
    echo "PASS: $desc"; pass=$((pass + 1))
  else
    echo "FAIL: $desc (expected to contain: $needle)"; fail=$((fail + 1))
  fi
}

if [ -x "$SCRIPT" ]; then
  echo "PASS: setup.sh is executable"; pass=$((pass + 1))
else
  echo "FAIL: setup.sh is not executable"; fail=$((fail + 1))
fi

bash -n "$SCRIPT" && { echo "PASS: setup.sh has valid bash syntax"; pass=$((pass + 1)); } \
  || { echo "FAIL: setup.sh has a syntax error"; fail=$((fail + 1)); }

# --help
out=$("$SCRIPT" --help)
rc=0; "$SCRIPT" --help >/dev/null || rc=$?
check "--help exits 0" "0" "$rc"
check_contains "--help shows usage" "$out" "Usage: setup.sh"

# unknown arg
rc=0; "$SCRIPT" --bogus >/dev/null 2>&1 || rc=$?
check "unknown arg exits 2" "2" "$rc"

# --- Scratch env: fake HOME + fake PATH, so no real machine state leaks in or is touched ---
SCRATCH="$(mktemp -d)"
trap 'rm -rf "$SCRATCH"' EXIT
FAKE_HOME="$SCRATCH/home"
FAKE_BIN_EMPTY="$SCRATCH/bin-empty"
FAKE_BIN_FULL="$SCRATCH/bin-full"
mkdir -p "$FAKE_HOME" "$FAKE_BIN_EMPTY" "$FAKE_BIN_FULL"

# Minimal PATH (git/bash/coreutils only) so no dependency is "found" by accident.
MINIMAL_PATH="/usr/bin:/bin"

# --check with nothing on PATH: everything should be MISSING, no side effects, exit 1.
before_ls=$(/bin/ls -1a "$FAKE_HOME")
out=$(env -i HOME="$FAKE_HOME" PATH="$MINIMAL_PATH" "$SCRIPT" --check 2>&1) && rc=0 || rc=$?
check "--check with nothing installed exits 1" "1" "$rc"
# Note: git is deliberately not asserted missing here — macOS ships a real /usr/bin/git even in
# a minimal PATH, so asserting it MISSING would be asserting a false fact about this machine.
check_contains "--check reports missing cmux" "$out" "[MISSING] cmux"
check_contains "--check reports missing pi" "$out" "[MISSING] pi (coding agent)"
check_contains "--check summary counts issues" "$out" "item(s) need attention"
after_ls=$(/bin/ls -1a "$FAKE_HOME")
check "--check makes no changes under \$HOME" "$before_ls" "$after_ls"

# Build a fully-mocked PATH: every dependency present, and mocked to behave successfully.
cat > "$FAKE_BIN_FULL/git"   <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
cat > "$FAKE_BIN_FULL/gh" <<'EOF'
#!/usr/bin/env bash
[ "$1" = "auth" ] && [ "$2" = "status" ] && exit 0
exit 0
EOF
cat > "$FAKE_BIN_FULL/node" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
cat > "$FAKE_BIN_FULL/npm"  <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
cat > "$FAKE_BIN_FULL/linear-cli" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
cat > "$FAKE_BIN_FULL/cmux" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
cat > "$FAKE_BIN_FULL/outfitter" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
cat > "$FAKE_BIN_FULL/pi" <<'EOF'
#!/usr/bin/env bash
if [ "$1" = "list" ]; then
  printf 'pi-mcp-adapter\npi-subagents\n@gotgenes/pi-permission-system\n'
  exit 0
fi
exit 0
EOF
chmod +x "$FAKE_BIN_FULL"/*

# Pre-seed the pi auth file + bootstrap-managed symlinks so the "all OK" path is fully exercised.
mkdir -p "$FAKE_HOME/.pi/agent"
echo '{}' > "$FAKE_HOME/.pi/agent/auth.json"
ln -s "$DIR/mcp.json" "$FAKE_HOME/.pi/agent/mcp.json"
ln -s "$DIR/agents" "$FAKE_HOME/.pi/agent/agents"
mkdir -p "$FAKE_HOME/.pi/agent/extensions/pi-permission-system"
ln -s "$DIR/permission-system/config.json" "$FAKE_HOME/.pi/agent/extensions/pi-permission-system/config.json"

out=$(env -i HOME="$FAKE_HOME" PATH="$FAKE_BIN_FULL:$MINIMAL_PATH" "$SCRIPT" --check 2>&1) && rc=0 || rc=$?
check "--check with everything present exits 0" "0" "$rc"
check_contains "--check reports OK git" "$out" "[OK]      git"
check_contains "--check reports OK pi-permission-system package" "$out" "[OK]      @gotgenes/pi-permission-system (pi package)"
check_contains "--check reports OK gh auth" "$out" "[OK]      gh (GitHub CLI) authenticated"
check_contains "--check reports OK config symlinks" "$out" "[OK]      $FAKE_HOME/.pi/agent/mcp.json"
check_contains "--check all-clear summary" "$out" "All checks passed."

echo "---"
echo "Results: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
