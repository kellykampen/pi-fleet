#!/usr/bin/env bash
# peek-lead-env.sh — establishes the project lead's own PEEK_* identity (role=orchestrator, NOT
# worker) at session startup, exported before exec so it's inherited by every bash tool call the
# lead makes for the rest of the session (including its cmux send cast commands).
#
# Without this, "$PEEK_ID" is unset in the lead's shell, so skills/project-lead/SKILL.md's cast
# command `PEEK_PARENT="$PEEK_ID" <wrapper>` forwards an empty string and every cast worker
# registers parentless — see bin/pi-fleet-eval-peekenv's degradation case.
#
# A project lead is itself cast (by a conductor, or started directly) — if it inherits a PEEK_ID
# (or PEEK_PARENT/PEEK_ORCH_ID), that's preserved as its own PEEK_PARENT before minting its id,
# same ordering rule as worker registration.

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SELF_DIR/peek-common.sh"
_peek_register orchestrator lead
unset -f _peek_gen_id _peek_register
unset SELF_DIR
