# Resolve the pi-xai-oauth extension that registers the `xai-auth` provider.
#
# `xai-auth` is NOT a built-in pi provider. It is registered by the installed
# package `npm:pi-xai-oauth`. Fleet lead/conductor wrappers pass `--no-extensions`
# (FLT-35) to block machine-global package auto-discovery (scheduler leakage).
# That also drops `xai-auth`, so Grok casts against those seats fail with
# `Unknown provider "xai-auth"` even when interactive `pi` (packages on) works.
#
# Explicit `--extension` flags still load after `--no-extensions`. Re-include
# only this package when present so FLT-55 Grok routing works without bringing
# back the full global package set.
#
# Usage (after --no-extensions in the outfitter argv):
#   . "$FLEET_ROOT/bin/lib/pi-xai-oauth-ext.sh"
#   ... --no-extensions ... ${PI_XAI_OAUTH_EXT_ARGS[@]+"${PI_XAI_OAUTH_EXT_ARGS[@]}"} ...

pi_xai_oauth_ext_resolve() {
  PI_XAI_OAUTH_EXT_ARGS=()
  local candidate="${PI_XAI_OAUTH_EXT:-$HOME/.pi/agent/npm/node_modules/pi-xai-oauth/extensions/xai-oauth.ts}"
  if [ -f "$candidate" ]; then
    PI_XAI_OAUTH_EXT_ARGS=(--extension "$candidate")
  fi
}

pi_xai_oauth_ext_resolve
