#!/usr/bin/env bash
# peek-common.sh — shared PEEK_* identity-registration core, used by:
#   bin/lib/peek-env.sh           (worker-tier wrappers, role=worker)
#   bin/lib/peek-lead-env.sh      (pi-project-lead, role=orchestrator)
# Not sourced directly — source one of the above instead.
#
# Order matters: whatever PEEK_ID a process inherits from its environment belongs to whoever cast
# it, not to this process itself — so we must capture that inherited id as PEEK_PARENT *before*
# minting this process's own PEEK_ID, or the parent link is lost.

_peek_gen_id() {
  local prefix="$1"
  if command -v uuidgen >/dev/null 2>&1; then
    printf '%s-%s' "$prefix" "$(uuidgen | tr '[:upper:]' '[:lower:]')"
  else
    printf '%s-%s-%s-%s' "$prefix" "$(date +%s)" "$$" "${RANDOM:-0}"
  fi
}

# _peek_register <default_role> <id_prefix>
_peek_register() {
  local default_role="$1" id_prefix="$2"
  if [ -n "${PEEK_PARENT:-}" ]; then
    # Parent link already provided explicitly by whoever cast us — trust it, just fill gaps.
    export PEEK_ID="${PEEK_ID:-$(_peek_gen_id "$id_prefix")}"
  else
    # No parent link yet: any inherited PEEK_ID (or PEEK_ORCH_ID) describes our caster, not us —
    # capture it as our parent before replacing PEEK_ID with our own identity.
    export PEEK_PARENT="${PEEK_ID:-${PEEK_ORCH_ID:-}}"
    export PEEK_ID="$(_peek_gen_id "$id_prefix")"
  fi
  export PEEK_ROLE="${PEEK_ROLE:-$default_role}"
  export PEEK_WORKSPACE="${PEEK_WORKSPACE:-${CMUX_WORKSPACE_ID:-}}"
}
