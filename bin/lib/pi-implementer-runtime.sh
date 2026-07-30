#!/usr/bin/env bash
# Build an isolated Pi agent overlay for the implementer seat so fleet-tracked
# permission-system/implementer.json (yoloMode + hard secret path denials) is the
# global config for the run. Does NOT change cwd — implementer must write in the
# product worktree. Caller-project PS config may still merge when trusted; deny
# stays deny under yoloMode and the --tools allowlist remains the primary boundary.
set -euo pipefail

pi_implementer_prepare_runtime() {
  local fleet_root="$1"
  local source_agent_dir="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
  local runtime_root runtime_agent package_path
  runtime_root="${FLEET_IMPLEMENTER_RUNTIME_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/pi-fleet/implementer-runtime}"
  runtime_agent="$runtime_root/agent"
  package_path="$source_agent_dir/npm/node_modules/@gotgenes/pi-permission-system"

  if [ ! -d "$package_path" ]; then
    package_path="$(PI_CODING_AGENT_DIR="$source_agent_dir" pi list 2>/dev/null | awk '
      $1 == "npm:@gotgenes/pi-permission-system" { getline; sub(/^[[:space:]]+/, ""); print; exit }
    ')"
  fi
  if [ -z "$package_path" ] || [ ! -d "$package_path" ]; then
    package_path="$HOME/.pi/agent/npm/node_modules/@gotgenes/pi-permission-system"
  fi
  if [ ! -d "$package_path" ]; then
    package_path="$(PI_CODING_AGENT_DIR="$HOME/.pi/agent" pi list 2>/dev/null | awk '
      $1 == "npm:@gotgenes/pi-permission-system" { getline; sub(/^[[:space:]]+/, ""); print; exit }
    ')"
  fi
  if [ -z "$package_path" ] || [ ! -d "$package_path" ]; then
    echo "pi-implementer: @gotgenes/pi-permission-system is not installed; run setup.sh" >&2
    return 1
  fi

  mkdir -p "$runtime_agent/extensions/pi-permission-system"
  ln -sfn "$fleet_root/permission-system/implementer.json" \
    "$runtime_agent/extensions/pi-permission-system/config.json"

  local file
  for file in auth.json models.json settings.json keybindings.json trust.json; do
    if [ -f "$source_agent_dir/$file" ]; then
      ln -sfn "$source_agent_dir/$file" "$runtime_agent/$file"
    fi
  done

  export PI_CODING_AGENT_DIR="$runtime_agent"
  export PI_PERMISSION_SYSTEM_PATH="$package_path"
  export PI_FLEET_ROOT="$fleet_root"
}
