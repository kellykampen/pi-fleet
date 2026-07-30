#!/usr/bin/env bash
# Smoke: fleet-mail send/inbox/ack between two local seats without cmux send.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
export HOME="$TMP/home"
export PI_FLEET_HOME="$HOME/.pi-fleet"
mkdir -p "$PI_FLEET_HOME"
MAIL="$ROOT/bin/fleet-mail"

"$MAIL" send --from worker:demo --to project-lead --type status --ticket FLT-58 --body "smoke status 1"
"$MAIL" send --from worker:demo --to project-lead --type status --ticket FLT-58 --body "smoke status 2"
unread="$("$MAIL" inbox --mailbox project-lead --unread --json)"
python3 - "$unread" <<'PY'
import json,sys
msgs=json.loads(sys.argv[1])
assert len(msgs)==1, msgs
assert msgs[0]["body"]=="smoke status 2", msgs
assert msgs[0]["type"]=="status"
msg_id=msgs[0]["id"]
open(sys.argv[2],"w").write(msg_id) if False else None
print(msgs[0]["id"])
PY
id="$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])[0]["id"])' "$unread")"

# worker → conductor must fail closed
if "$MAIL" send --from worker --to conductor --type status --ticket FLT-58 --body "bad" 2>/dev/null; then
  echo "expected topology deny for worker→conductor" >&2
  exit 1
fi

# lead rollup to conductor
"$MAIL" send --from project-lead --to conductor --type status --ticket FLT-58 --body "rollup: smoke green"
"$MAIL" ack --mailbox project-lead --id "$id"
empty="$("$MAIL" inbox --mailbox project-lead --unread --json)"
[[ "$empty" == "[]" ]]

# FLT-68: named <workspace>-project-lead is a first-class mailbox (no generic fallback required)
"$MAIL" send --from conductor --to pi-fleet-project-lead --type status --ticket FLT-68 \
  --body "named assign"
"$MAIL" send --from worker:flt-68 --to pi-fleet-project-lead --type status --ticket FLT-68 \
  --body "named worker status"
named="$("$MAIL" inbox --mailbox pi-fleet-project-lead --unread --json)"
python3 - "$named" <<'PY'
import json,sys
msgs=json.loads(sys.argv[1])
assert len(msgs)==2, msgs
assert all(m["to"]=="pi-fleet-project-lead" for m in msgs), msgs
print("named-ok")
PY
"$MAIL" send --from pi-fleet-project-lead --to conductor --type status --ticket FLT-68 \
  --body "named rollup"

# node unit tests
node --test "$ROOT/evals/fleet-mail.test.mjs"

echo "ok - fleet-mail smoke (send/inbox/ack + topology + status replace + named lead + unit tests)"
