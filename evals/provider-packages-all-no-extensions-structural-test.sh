#!/usr/bin/env bash
# Structural: every fleet seat that passes --no-extensions re-includes both
# pi-xai-oauth (xai-auth / Grok) and pi-provider-kimi-code (kimi-coding / k3)
# so FLT-55 / FLT-70 non-GPT casts work under unattended wrappers.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

pass=0
fail=0
ok() { echo "PASS: $1"; pass=$((pass + 1)); }
no() { echo "FAIL: $1"; fail=$((fail + 1)); }

# Seat wrappers that must wire provider packages under --no-extensions.
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
  if grep -q 'pi-kimi-code-ext.sh' "$f"; then
    ok "$seat sources pi-kimi-code-ext.sh"
  else
    no "$seat sources pi-kimi-code-ext.sh"
  fi
  if grep -q 'PI_KIMI_CODE_EXT_ARGS' "$f"; then
    ok "$seat expands PI_KIMI_CODE_EXT_ARGS into outfitter argv"
  else
    no "$seat expands PI_KIMI_CODE_EXT_ARGS into outfitter argv"
  fi
done

# Docs describe both packages and the correct Kimi model id (k3, not k/3).
if grep -q 'pi-implementer' "$ROOT/docs/model-overrides.md" \
  && grep -q 'pi-xai-oauth-ext.sh' "$ROOT/docs/model-overrides.md" \
  && grep -q 'pi-kimi-code-ext.sh' "$ROOT/docs/model-overrides.md" \
  && grep -q 'pi-provider-kimi-code' "$ROOT/docs/model-overrides.md" \
  && grep -Eq 'implementer.*reviewer.*ac-verifier|workers:.*implementer' "$ROOT/docs/model-overrides.md"; then
  ok "model-overrides.md documents worker xai + kimi re-include"
else
  no "model-overrides.md documents worker xai + kimi re-include"
fi

if grep -qE -- '--model k3' "$ROOT/docs/model-overrides.md" \
  && ! grep -qE -- '--model k/3' "$ROOT/docs/model-overrides.md"; then
  ok "model-overrides.md uses model id k3 (not k/3)"
else
  no "model-overrides.md uses model id k3 (not k/3)"
fi

if grep -q 'implementer, reviewer, ac-verifier' "$ROOT/bin/lib/pi-xai-oauth-ext.sh"; then
  ok "pi-xai-oauth-ext.sh header lists all wired seats"
else
  no "pi-xai-oauth-ext.sh header lists all wired seats"
fi

if grep -q 'implementer, reviewer, ac-verifier' "$ROOT/bin/lib/pi-kimi-code-ext.sh"; then
  ok "pi-kimi-code-ext.sh header lists all wired seats"
else
  no "pi-kimi-code-ext.sh header lists all wired seats"
fi

# No --no-extensions wrapper outside the known set should silently lack provider wiring.
while IFS= read -r f; do
  base="$(basename "$f")"
  case "$base" in
    pi-fleet*|pi-implementer|pi-reviewer|pi-ac-verifier|pi-planner|pi-spike-breakdown|pi-project-lead|pi-conductor)
      continue
      ;;
  esac
  if grep -q -- '--no-extensions' "$f"; then
    if ! grep -q 'pi-xai-oauth-ext.sh' "$f"; then
      no "unexpected --no-extensions seat without xai wiring: $base"
    fi
    if ! grep -q 'pi-kimi-code-ext.sh' "$f"; then
      no "unexpected --no-extensions seat without kimi wiring: $base"
    fi
  fi
done < <(find "$ROOT/bin" -maxdepth 1 -type f -name 'pi-*' | sort)

echo "---"
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
