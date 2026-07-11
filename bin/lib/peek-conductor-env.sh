#!/usr/bin/env bash
# peek-conductor-env.sh — establishes the conductor's own PEEK_* identity. Per peek's documented
# "Special case — you're the conductor": a fixed id, no parent, no workspace needed — registration
# is cwd-agnostic and routes into peek's reserved conductor slot. Exported before exec so it's
# inherited by every bash tool call the conductor makes for the rest of the session.
export PEEK_ROLE="${PEEK_ROLE:-conductor}"
export PEEK_ID="${PEEK_ID:-conductor}"
