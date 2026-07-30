#!/usr/bin/env bash
# Build an isolated Pi agent overlay and policy cwd for the project-lead seat.
# FLT-67: @gotgenes/pi-permission-system is removed. Security is --tools +
# extensions/project-lead-policy.ts only. Isolation still keeps the caller's cwd as
# FLEET_COORDINATION_ROOT (via launch-cwd/) and avoids inheriting caller project
# state into the seat agent dir.
set -euo pipefail

pi_project_lead_prepare_runtime() {
  local fleet_root="$1"
  local source_agent_dir="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
  local launch_cwd runtime_root runtime_agent policy_cwd
  launch_cwd="$(pwd -P)"
  runtime_root="${FLEET_PROJECT_LEAD_RUNTIME_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/pi-fleet/project-lead-runtime}"
  runtime_agent="$runtime_root/agent"
  policy_cwd="$runtime_root/policy-cwd"

  mkdir -p "$runtime_agent" "$policy_cwd"
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
  export FLEET_COORDINATION_ROOT="$launch_cwd"
  export PI_FLEET_ROOT="$fleet_root"
  export PATH="$fleet_root/bin:$PATH"

  # FLT-69: derive workspace + lead mailbox + allowed repo roots from
  # $PI_FLEET_HOME/workspaces.json (hard-exported for this seat and cast workers).
  # shellcheck source=fleet-workspaces.sh
  . "$fleet_root/bin/lib/fleet-workspaces.sh"
  fleet_workspaces_ensure_file >/dev/null 2>&1 || true
  fleet_workspaces_resolve_and_export || {
    echo "pi-project-lead: workspace registry resolve failed" >&2
    return 1
  }

  # FLT-68: if registry did not set a mailbox, fall back to cwd/key-based <workspace>-project-lead.
  # shellcheck source=fleet-lead-mailbox.sh
  . "$fleet_root/bin/lib/fleet-lead-mailbox.sh"
  fleet_resolve_lead_mailbox || true

  # Unset any leftover PS path from the environment so it cannot reappear in argv.
  unset PI_PERMISSION_SYSTEM_PATH 2>/dev/null || true
  cd "$policy_cwd"
}
