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
# lead's process env. `bin/lib/peek-lead-env.sh` is what gives the lead's own `$PEEK_ID` a real
# value to forward — without it, PEEK_PARENT="$PEEK_ID" forwards an empty string and the worker
# below degrades to parentless (see bin/pi-fleet-eval-peekenv's degradation case).
# If PEEK_PARENT arrives unset (e.g. a worker launched directly, without a lead), we fall back to
# whatever PEEK_ID/PEEK_ORCH_ID is already in the environment.

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SELF_DIR/peek-common.sh"
_peek_register worker worker
unset -f _peek_gen_id _peek_register
unset SELF_DIR
