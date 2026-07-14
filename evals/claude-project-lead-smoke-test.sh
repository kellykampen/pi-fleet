#!/usr/bin/env bash
# Deterministic wrapper smoke: mock Claude and assert the project-lead restriction wiring.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WRAPPER="$DIR/bin/claude-project-lead"
FAKE_BIN="$(mktemp -d)"
trap 'rm -rf "$FAKE_BIN"' EXIT

cat > "$FAKE_BIN/claude" <<'EOF'
#!/usr/bin/env bash
printf 'PI_FLEET_ROOT=%s\n' "${PI_FLEET_ROOT-}"
printf 'FLEET_COORDINATION_ROOT=%s\n' "${FLEET_COORDINATION_ROOT-}"
printf 'PATH=%s\n' "$PATH"
printf 'ARG=%s\n' "$@"
EOF
chmod +x "$FAKE_BIN/claude"

pass=0; fail=0
ok() { echo "PASS: $1"; pass=$((pass + 1)); }
no() { echo "FAIL: $1"; fail=$((fail + 1)); }
contains() {
  local desc="$1" value="$2" output="$3"
  if printf '%s\n' "$output" | grep -Fqx -- "$value"; then ok "$desc"; else no "$desc (missing: $value)"; fi
}
rejects() {
  local desc="$1" value="$2" output="$3"
  if printf '%s\n' "$output" | grep -Fqx -- "$value"; then no "$desc (found: $value)"; else ok "$desc"; fi
}

out=$(cd /tmp && env -u FLEET_YOLO LEAD_MODEL=opus PATH="$FAKE_BIN:$PATH" "$WRAPPER" --extra flag)
contains "lead model retained" "ARG=opus" "$out"
contains "project-lead settings loaded" "ARG=$DIR/claude-settings/project-lead.json" "$out"
contains "mutation tools disallowed" "ARG=Edit Write NotebookEdit" "$out"
contains "fleet root exported for hook" "PI_FLEET_ROOT=$DIR" "$out"
contains "launch cwd is coordination root" "FLEET_COORDINATION_ROOT=$(cd /tmp && pwd -P)" "$out"
contains "fleet-note directory is prepended to PATH" "PATH=$DIR/bin:$FAKE_BIN:$PATH" "$out"
contains "project-lead prompt loaded" "ARG=$(cat "$DIR/skills/project-lead/SKILL.md")" "$out"
contains "extra args forwarded" "ARG=--extra" "$out"

out=$(cd /tmp && FLEET_YOLO=1 PATH="$FAKE_BIN:$PATH" "$WRAPPER")
rejects "permission bypass is impossible even with FLEET_YOLO" "ARG=--dangerously-skip-permissions" "$out"

echo "---"
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
