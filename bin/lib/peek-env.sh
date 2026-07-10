#!/usr/bin/env bash
# peek-env.sh — shared PEEK_* env contract for worker-seat wrappers (see skills/peek).
#
# Source this near the top of a worker wrapper, BEFORE anything else reads/writes PEEK_ID. Order
# matters: whatever PEEK_ID a worker process inherits from its environment belongs to whoever cast
# it (a project lead or conductor), not to the worker itself — so we must capture that inherited
# id as PEEK_PARENT *before* minting the worker's own PEEK_ID, or the parent link is lost.
#
# A project lead's cast command should forward its own identity explicitly, e.g.:
#   cmux send ... "cd <worktree> && PEEK_PARENT=\"$PEEK_ID\" pi-implementer"
# so the new pane sees PEEK_PARENT set even though it's a fresh shell that didn't inherit the
# lead's process env. If PEEK_PARENT arrives unset (e.g. a worker launched directly, without a
# lead), we fall back to whatever PEEK_ID/PEEK_ORCH_ID is already in the environment.

_peek_gen_id() {
  if command -v uuidgen >/dev/null 2>&1; then
    printf 'worker-%s' "$(uuidgen | tr '[:upper:]' '[:lower:]')"
  else
    printf 'worker-%s-%s-%s' "$(date +%s)" "$$" "${RANDOM:-0}"
  fi
}

if [ -n "${PEEK_PARENT:-}" ]; then
  # Parent link already provided explicitly by whoever cast us — trust it, just fill gaps.
  export PEEK_ID="${PEEK_ID:-$(_peek_gen_id)}"
else
  # No parent link yet: any inherited PEEK_ID (or PEEK_ORCH_ID) describes our caster, not us —
  # capture it as our parent before replacing PEEK_ID with our own identity.
  export PEEK_PARENT="${PEEK_ID:-${PEEK_ORCH_ID:-}}"
  export PEEK_ID="$(_peek_gen_id)"
fi

export PEEK_ROLE="${PEEK_ROLE:-worker}"
export PEEK_WORKSPACE="${PEEK_WORKSPACE:-${CMUX_WORKSPACE_ID:-}}"

unset -f _peek_gen_id
