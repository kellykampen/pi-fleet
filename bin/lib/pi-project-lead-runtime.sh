#!/usr/bin/env bash
# Build an isolated Pi agent/config overlay and policy cwd for the project-lead seat.
# This prevents a permissive project-local permission config in the caller's cwd from overriding
# the tracked project-lead policy. The caller cwd remains available as the coordination-note root.
set -euo pipefail

pi_project_lead_prepare_runtime() {
  local fleet_root="$1"
  local source_agent_dir="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
  local launch_cwd runtime_root runtime_agent policy_cwd package_path
  launch_cwd="$(pwd -P)"
  runtime_root="${FLEET_PROJECT_LEAD_RUNTIME_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/pi-fleet/project-lead-runtime}"
  runtime_agent="$runtime_root/agent"
  policy_cwd="$runtime_root/policy-cwd"
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
    echo "pi-project-lead: @gotgenes/pi-permission-system is not installed; run setup.sh" >&2
    return 1
  fi

  mkdir -p \
    "$runtime_agent/extensions/pi-permission-system" \
    "$policy_cwd/.pi/extensions/pi-permission-system"
  ln -sfn "$fleet_root/permission-system/project-lead.json" \
    "$runtime_agent/extensions/pi-permission-system/config.json"
  ln -sfn "$fleet_root/permission-system/project-lead.json" \
    "$policy_cwd/.pi/extensions/pi-permission-system/config.json"
  if [ -e "$policy_cwd/launch-cwd" ] && [ ! -L "$policy_cwd/launch-cwd" ]; then
    echo "pi-project-lead: refusing non-symlink runtime launch-cwd target" >&2
    return 1
  fi
  ln -sfn "$launch_cwd" "$policy_cwd/launch-cwd"

  # Pi core reads identity/settings from the isolated agent dir. Link only the known data files;
  # extension discovery remains disabled and packages are loaded explicitly by the wrapper.
  local file
  for file in auth.json models.json settings.json keybindings.json trust.json; do
    if [ -f "$source_agent_dir/$file" ]; then
      ln -sfn "$source_agent_dir/$file" "$runtime_agent/$file"
    fi
  done

  export PI_CODING_AGENT_DIR="$runtime_agent"
  export PI_PERMISSION_SYSTEM_PATH="$package_path"
  export FLEET_COORDINATION_ROOT="$launch_cwd"
  export PI_FLEET_ROOT="$fleet_root"
  export PATH="$fleet_root/bin:$PATH"
  cd "$policy_cwd"
}
