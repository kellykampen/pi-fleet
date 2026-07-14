#!/usr/bin/env bash
# FLT-15 regression guard for Linear extension pathing.
#
# Outfitter/Pi currently pass profile-managed `extensions:` through as literal `--extension`
# values. Unlike skills, those relative extension paths are not anchored to profile.yml/source-root;
# they resolve from the process launch cwd. Fleet seats that must launch from arbitrary project
# directories therefore resolve repo-local extensions in wrappers, from the wrapper's own location.
#
# This smoke is deterministic and non-interactive: it shadows `outfitter` with a tiny argv printer,
# launches wrappers from several cwds, and audits profile YAML for portable (non-machine-specific)
# Linear extension references where profiles still own them.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FAKE_BIN="$(mktemp -d)"
FAKE_HOME="$(mktemp -d)"
trap 'rm -rf "$FAKE_BIN" "$FAKE_HOME"' EXIT

# pi-conductor's runtime (FLT-52) hard-requires @gotgenes/pi-permission-system under the
# resolved agent dir before it will run at all. Stub a resolvable package dir under this
# sandbox's HOME so the conductor wrapper can complete setup here rather than failing on a
# precondition this smoke test isn't exercising.
mkdir -p "$FAKE_HOME/.pi/agent/npm/node_modules/@gotgenes/pi-permission-system"

cat > "$FAKE_BIN/outfitter" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$@"
EOF
chmod +x "$FAKE_BIN/outfitter"

pass=0; fail=0
ok() { echo "PASS: $1"; pass=$((pass + 1)); }
no() { echo "FAIL: $1"; fail=$((fail + 1)); }
check() {
  local desc="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then
    ok "$desc"
  else
    no "$desc"
    echo "  expected: $(printf '%q' "$expected")"
    echo "  actual:   $(printf '%q' "$actual")"
  fi
}

extract_extension_args() {
  awk '/^--extension$/ { getline; print }'
}

run_wrapper_from() {
  local wrapper="$1" cwd="$2"
  (cd "$cwd" && env -u FLEET_YOLO -u E2B_API_KEY -u FLEET_GITHUB_TOKEN HOME="$FAKE_HOME" \
    PATH="$FAKE_BIN:$PATH" "$wrapper" --print "hi")
}

assert_wrapper_linear_extension() {
  local name="$1"
  local wrapper="$DIR/bin/$name"
  if [ -x "$wrapper" ]; then ok "$name wrapper is executable"; else no "$name wrapper is not executable"; fi
  for cwd in "$DIR" "$HOME" /tmp; do
    local out extensions linear_path
    out="$(run_wrapper_from "$wrapper" "$cwd")"
    extensions="$(printf '%s\n' "$out" | extract_extension_args)"
    linear_path="$(printf '%s\n' "$extensions" | grep '/extensions/linear\.ts$' | head -1 || true)"
    check "$name passes repo-local linear.ts extension when launched from $cwd" \
      "$DIR/extensions/linear.ts" "$linear_path"
    if [ -e "$linear_path" ]; then ok "$name resolved linear.ts exists on disk"; else no "$name resolved linear.ts missing: $linear_path"; fi
  done
}

assert_no_profile_extensions() {
  local profile="$1"
  local path="$DIR/profiles/$profile/profile.yml"
  if grep -q '^    extensions:' "$path"; then
    no "profiles/$profile/profile.yml omits cwd-sensitive profile-managed extensions"
  else
    ok "profiles/$profile/profile.yml omits cwd-sensitive profile-managed extensions"
  fi
}

assert_profile_repo_relative_linear_extension() {
  local profile="$1"
  local path="$DIR/profiles/$profile/profile.yml"
  local expected='../extensions/linear.ts'
  if grep -q -- "- $expected" "$path"; then
    ok "profiles/$profile/profile.yml keeps portable $expected"
  else
    no "profiles/$profile/profile.yml keeps portable $expected"
  fi
  # This is the intended source-root interpretation for portable profile references.
  if [ -f "$DIR/profiles/$expected" ]; then
    ok "profiles/$profile $expected resolves inside this clone"
  else
    no "profiles/$profile $expected does not resolve inside this clone"
  fi
}

# Wrapper-managed launch-critical seats: must work from arbitrary project cwds.
assert_wrapper_linear_extension pi-project-lead
assert_wrapper_linear_extension pi-conductor

# Project-lead also owns the E2B extension; verify it is wrapper-resolved and clone-local.
project_lead_out="$(run_wrapper_from "$DIR/bin/pi-project-lead" /tmp)"
project_lead_exts="$(printf '%s\n' "$project_lead_out" | extract_extension_args)"
check "pi-project-lead passes repo-local e2b extension" "$DIR/extensions/e2b" \
  "$(printf '%s\n' "$project_lead_exts" | grep '/extensions/e2b$' | head -1 || true)"

assert_no_profile_extensions project-lead
assert_no_profile_extensions conductor

# Worker/utility profiles that still declare Linear keep the portable repo-relative reference,
# never a developer-machine absolute path.
for profile in ac-verifier docs implementer linear personal-assistant planner reviewer spike-breakdown; do
  assert_profile_repo_relative_linear_extension "$profile"
done

if grep -R -n '/Users/' "$DIR/profiles" >/tmp/pi-fleet-profile-absolute-paths.$$; then
  no "profiles do not contain machine-specific /Users paths"
  cat /tmp/pi-fleet-profile-absolute-paths.$$
else
  ok "profiles do not contain machine-specific /Users paths"
fi
rm -f /tmp/pi-fleet-profile-absolute-paths.$$

echo "---"
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
