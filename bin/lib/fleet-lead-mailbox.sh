#!/usr/bin/env bash
# FLT-68: resolve the project-lead seat / fleet-mail mailbox name.
#
# Canonical form: <workspace_name>-project-lead
# Examples: agent-skills-project-lead, ftd-project-lead, pi-fleet-project-lead
#
# The mailbox MUST match the cmux pane/tab name exactly so conductor named send
# and worker uplink land in the same inbox the lead polls.
#
# Resolution order:
#   1. FLEET_LEAD_MAILBOX (full mailbox id, if already a *-project-lead / project-lead)
#   2. FLEET_MAIL_FROM when it is already a project-lead mailbox
#   3. FLEET_PROJECT_KEY or CMUX_WORKSPACE_NAME → <key>-project-lead
#   4. basename of FLEET_COORDINATION_ROOT / cwd (last path segment) → <key>-project-lead
#   5. empty (caller may fall back to legacy "project-lead" for tests only)
#
# Exports (when a name is resolved):
#   FLEET_LEAD_MAILBOX   full mailbox id
#   FLEET_PROJECT_KEY    workspace key without -project-lead suffix
#   FLEET_MAIL_FROM      set to FLEET_LEAD_MAILBOX when previously unset
#   FLEET_SEAT_NAME      same as FLEET_LEAD_MAILBOX (cmux pane/tab title target)

fleet_sanitize_workspace_key() {
  local raw="${1:-}"
  # shellcheck disable=SC2001
  raw="$(printf '%s' "$raw" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9._-]+/-/g; s/^-+//; s/-+$//')"
  case "$raw" in
    ""|"."|"..") printf '' ;;
    *-project-lead) printf '%s' "${raw%-project-lead}" ;;
    *) printf '%s' "$raw" ;;
  esac
}

fleet_is_project_lead_mailbox() {
  local id="${1:-}"
  case "$id" in
    project-lead) return 0 ;;
    project-lead:*)
      local scope="${id#project-lead:}"
      [[ -n "$scope" && "$scope" != *:* ]]
      ;;
    *-project-lead)
      local prefix="${id%-project-lead}"
      [[ -n "$prefix" && "$prefix" != *:* ]]
      ;;
    *) return 1 ;;
  esac
}

fleet_resolve_lead_mailbox() {
  local explicit key root base
  explicit="${FLEET_LEAD_MAILBOX:-}"
  if [[ -z "$explicit" ]] && fleet_is_project_lead_mailbox "${FLEET_MAIL_FROM:-}"; then
    explicit="${FLEET_MAIL_FROM}"
  fi
  if [[ -n "$explicit" ]]; then
    if ! fleet_is_project_lead_mailbox "$explicit"; then
      echo "fleet-lead-mailbox: FLEET_LEAD_MAILBOX/FLEET_MAIL_FROM must be a project-lead mailbox (got $explicit)" >&2
      return 2
    fi
    FLEET_LEAD_MAILBOX="$explicit"
    if [[ "$explicit" == *-project-lead ]]; then
      FLEET_PROJECT_KEY="${explicit%-project-lead}"
    elif [[ "$explicit" == project-lead:* ]]; then
      FLEET_PROJECT_KEY="${explicit#project-lead:}"
    else
      FLEET_PROJECT_KEY="${FLEET_PROJECT_KEY:-}"
    fi
  else
    key="$(fleet_sanitize_workspace_key "${FLEET_PROJECT_KEY:-${CMUX_WORKSPACE_NAME:-}}")"
    if [[ -z "$key" ]]; then
      root="${FLEET_COORDINATION_ROOT:-$(pwd -P 2>/dev/null || pwd)}"
      base="$(basename "$root" 2>/dev/null || true)"
      # Prefer repo folder name over worktree leaf for .../.worktrees/<ticket> or .../worktrees/<ticket>
      if [[ "$root" == *"/.worktrees/"* || "$root" == *"/worktrees/"* ]]; then
        base="$(basename "$(dirname "$(dirname "$root")")" 2>/dev/null || echo "$base")"
      fi
      key="$(fleet_sanitize_workspace_key "$base")"
    fi
    if [[ -z "$key" ]]; then
      FLEET_LEAD_MAILBOX=""
      return 0
    fi
    FLEET_LEAD_MAILBOX="${key}-project-lead"
    FLEET_PROJECT_KEY="$key"
  fi

  export FLEET_LEAD_MAILBOX
  export FLEET_PROJECT_KEY="${FLEET_PROJECT_KEY:-}"
  export FLEET_SEAT_NAME="$FLEET_LEAD_MAILBOX"
  if [[ -z "${FLEET_MAIL_FROM:-}" ]]; then
    export FLEET_MAIL_FROM="$FLEET_LEAD_MAILBOX"
  fi
  return 0
}
