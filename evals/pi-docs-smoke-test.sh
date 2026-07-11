#!/usr/bin/env bash
# pi-docs-smoke-test — proves the pi-docs profile/wrapper/agent/skill files exist with the right
# shape (FLT-18): profile.yml parses and points at the docs skill, the bin/pi-docs wrapper execs
# outfitter with --profile docs and a docs-scoped (no destructive-bash) --tools allowlist, and the
# agents/docs.md + skills/docs/SKILL.md content covers the required capabilities. No real
# `outfitter`/`pi` binary needed: a mock dropped in a temp PATH dir echoes its argv so we can
# assert exactly what the wrapper execs.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WRAPPER="$DIR/bin/pi-docs"
FAKE_BIN="$(mktemp -d)"
trap 'rm -rf "$FAKE_BIN"' EXIT

cat > "$FAKE_BIN/outfitter" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$@"
EOF
chmod +x "$FAKE_BIN/outfitter"

pass=0; fail=0
ok() { echo "PASS: $1"; pass=$((pass + 1)); }
bad() { echo "FAIL: $1"; fail=$((fail + 1)); }

echo "1) presence + executability"
[ -x "$WRAPPER" ] && ok "bin/pi-docs is executable" || bad "bin/pi-docs is executable"
[ -f "$DIR/profiles/docs/profile.yml" ] && ok "profiles/docs/profile.yml exists" || bad "profiles/docs/profile.yml exists"
[ -f "$DIR/skills/docs/SKILL.md" ] && ok "skills/docs/SKILL.md exists" || bad "skills/docs/SKILL.md exists"
[ -f "$DIR/agents/docs.md" ] && ok "agents/docs.md exists" || bad "agents/docs.md exists"

echo "2) profile.yml parses and points at the docs skill"
python3 -c "
import yaml, sys
d = yaml.safe_load(open('$DIR/profiles/docs/profile.yml'))
assert d['id'] == 'docs', 'id must be docs'
assert '../skills/docs' in d['controls']['pi']['skills'], 'must load ../skills/docs'
print('ok')
" && ok "profile.yml parses, id=docs, loads skills/docs" || bad "profile.yml parse/shape check"

echo "3) wrapper execs outfitter with --profile docs and a docs-scoped --tools list"
out=$(PATH="$FAKE_BIN:$PATH" "$WRAPPER")
if printf '%s\n' "$out" | grep -qx -- "--profile" && printf '%s\n' "$out" | grep -qx -- "docs"; then
  ok "wrapper passes --profile docs"
else
  bad "wrapper passes --profile docs"
fi
if printf '%s\n' "$out" | grep -q -- "--tools"; then
  ok "wrapper passes --tools"
else
  bad "wrapper passes --tools"
fi
TOOLS_LINE=$(printf '%s\n' "$out" | grep -A1 -- "--tools" | tail -1)
for t in write edit bash; do
  if printf '%s' "$TOOLS_LINE" | grep -q "$t"; then
    ok "tools include '$t' (docs pass needs to write/edit files + read git/gh diffs)"
  else
    bad "tools include '$t'"
  fi
done

echo "4) extra args forwarded"
out2=$(PATH="$FAKE_BIN:$PATH" "$WRAPPER" -p "docs pass for PR 24")
if printf '%s\n' "$out2" | grep -qx -- "-p" && printf '%s\n' "$out2" | grep -qx -- "docs pass for PR 24"; then
  ok "extra args forwarded to outfitter/pi"
else
  bad "extra args forwarded to outfitter/pi"
fi

echo "5) skill + agent content covers required capabilities (grep, docs-only checks)"
for phrase in "after independent review" "no docs changes needed" "does not re-review"; do
  if grep -qi "$phrase" "$DIR/skills/docs/SKILL.md"; then
    ok "skills/docs/SKILL.md covers: $phrase"
  else
    bad "skills/docs/SKILL.md covers: $phrase"
  fi
done

echo "---"
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
