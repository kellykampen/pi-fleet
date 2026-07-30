#!/usr/bin/env bash
# Structural: every fleet seat that passes --no-extensions re-includes pi-xai-oauth
# so --provider xai-auth works for Grok casts under the GPT usage guard.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

pass=0
fail=0
ok() { echo "PASS: $1"; pass=$((pass + 1)); }
no() { echo "FAIL: $1"; fail=$((fail + 1)); }

# Seat wrappers that must wire xai-oauth under --no-extensions.
SEATS=(
  pi-implementer
  pi-reviewer
  pi-ac-verifier
  pi-planner
  pi-spike-breakdown
  pi-project-lead
  pi-conductor
)

for seat in "${SEATS[@]}"; do
  f="$ROOT/bin/$seat"
  if [[ ! -f "$f" ]]; then
    no "$seat exists"
    continue
  fi
  ok "$seat exists"
  if grep -q -- '--no-extensions' "$f"; then
    ok "$seat passes --no-extensions"
  else
    no "$seat passes --no-extensions"
  fi
  if grep -q 'pi-xai-oauth-ext.sh' "$f"; then
    ok "$seat sources pi-xai-oauth-ext.sh"
  else
    no "$seat sources pi-xai-oauth-ext.sh"
  fi
  if grep -q 'PI_XAI_OAUTH_EXT_ARGS' "$f"; then
    ok "$seat expands PI_XAI_OAUTH_EXT_ARGS into outfitter argv"
  else
    no "$seat expands PI_XAI_OAUTH_EXT_ARGS into outfitter argv"
  fi
done

# Docs describe the full set, not lead/conductor only.
if grep -q 'pi-implementer' "$ROOT/docs/model-overrides.md" \
  && grep -q 'pi-xai-oauth-ext.sh' "$ROOT/docs/model-overrides.md" \
  && grep -Eq 'implementer.*reviewer.*ac-verifier|workers:.*implementer' "$ROOT/docs/model-overrides.md"; then
  ok "model-overrides.md documents worker xai-auth re-include"
else
  no "model-overrides.md documents worker xai-auth re-include"
fi

if grep -q 'implementer, reviewer, ac-verifier' "$ROOT/bin/lib/pi-xai-oauth-ext.sh"; then
  ok "pi-xai-oauth-ext.sh header lists all wired seats"
else
  no "pi-xai-oauth-ext.sh header lists all wired seats"
fi

# No --no-extensions wrapper outside the known set should silently lack xai wiring.
while IFS= read -r f; do
  base="$(basename "$f")"
  case "$base" in
    pi-fleet*|pi-implementer|pi-reviewer|pi-ac-verifier|pi-planner|pi-spike-breakdown|pi-project-lead|pi-conductor)
      continue
      ;;
  esac
  if grep -q -- '--no-extensions' "$f" && ! grep -q 'pi-xai-oauth-ext.sh' "$f"; then
    no "unexpected --no-extensions seat without xai wiring: $base"
  fi
done < <(find "$ROOT/bin" -maxdepth 1 -type f -name 'pi-*' | sort)

echo "---"
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
