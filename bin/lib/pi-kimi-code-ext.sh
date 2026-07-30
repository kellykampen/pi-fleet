# Resolve the pi-provider-kimi-code extension that registers the `kimi-coding` provider.
#
# `kimi-coding` is a known provider id in pi (default model kimi-for-coding), but the full
# model catalog — including Kimi K3 (`k3`, not `k/3`) — is registered by the installed
# package `npm:pi-provider-kimi-code`. Fleet wrappers that pass `--no-extensions` (FLT-35 /
# unattended seats) block machine-global package auto-discovery (scheduler leakage). That
# also drops the Kimi package, so K3 casts fall back to "Using custom model id" / hang /
# wrong stream handlers even when interactive `pi` (packages on) works.
#
# Explicit `--extension` flags still load after `--no-extensions`. Re-include only this
# package when present so FLT-55 / FLT-70 Kimi routing works without bringing back the full
# global package set.
#
# Wired into every --no-extensions fleet seat: implementer, reviewer, ac-verifier,
# planner, spike-breakdown, project-lead, conductor.
#
# Usage (after --no-extensions in the outfitter argv):
#   . "$FLEET_ROOT/bin/lib/pi-kimi-code-ext.sh"
#   ... --no-extensions ... ${PI_KIMI_CODE_EXT_ARGS[@]+"${PI_KIMI_CODE_EXT_ARGS[@]}"} ...

pi_kimi_code_ext_resolve() {
  PI_KIMI_CODE_EXT_ARGS=()
  local candidate

  if [ -n "${PI_KIMI_CODE_EXT:-}" ]; then
    candidate="$PI_KIMI_CODE_EXT"
    if [ -f "$candidate" ]; then
      PI_KIMI_CODE_EXT_ARGS=(--extension "$candidate")
    fi
    return
  fi

  local candidates=()
  if [ -n "${PI_CODING_AGENT_DIR:-}" ]; then
    candidates+=("$PI_CODING_AGENT_DIR/npm/node_modules/pi-provider-kimi-code/index.ts")
  fi
  candidates+=("$HOME/.pi/agent/npm/node_modules/pi-provider-kimi-code/index.ts")
  if [ -n "${PI_PACKAGE_DIR:-}" ]; then
    candidates+=(
      "$PI_PACKAGE_DIR/node_modules/pi-provider-kimi-code/index.ts"
      "$PI_PACKAGE_DIR/pi-provider-kimi-code/index.ts"
      "$PI_PACKAGE_DIR/index.ts"
    )
  fi

  for candidate in "${candidates[@]}"; do
    if [ -f "$candidate" ]; then
      PI_KIMI_CODE_EXT_ARGS=(--extension "$candidate")
      return
    fi
  done
}

pi_kimi_code_ext_resolve
