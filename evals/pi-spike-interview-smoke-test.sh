#!/usr/bin/env bash
# Non-interactive integration coverage for the spike interview wrapper. Browser and Linear CLIs are
# fakes under a scratch directory; this never opens a browser or writes to Linear.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="$ROOT/bin/pi-fleet-spike-interview"
SCRATCH="$(mktemp -d)"
trap 'rm -rf "$SCRATCH"' EXIT

pass=0
fail=0
check() {
  local description="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then
    echo "PASS: $description"
    pass=$((pass + 1))
  else
    echo "FAIL: $description (expected $(printf '%q' "$expected"), got $(printf '%q' "$actual"))"
    fail=$((fail + 1))
  fi
}
contains() {
  local description="$1" file="$2" needle="$3"
  if grep -qF -- "$needle" "$file"; then
    echo "PASS: $description"
    pass=$((pass + 1))
  else
    echo "FAIL: $description (missing: $needle)"
    fail=$((fail + 1))
  fi
}
json_field() {
  node -e 'const fs=require("fs"); try { const value=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); console.log(value[process.argv[2]]); } catch (error) { console.error(error.message); process.exit(2); }' "$1" "$2"
}

QUESTIONS="$SCRATCH/questions.json"
cat >"$QUESTIONS" <<'JSON'
{
  "title": "Spike decisions",
  "questions": [
    {
      "id": "architectural-001",
      "bucket": "architectural",
      "type": "single",
      "question": "Where should the boundary live?",
      "options": ["Service", "Library"],
      "recommended": "Library",
      "conviction": "strong",
      "weight": "critical",
      "context": "Recommendation reasoning: a library avoids a network hop."
    }
  ]
}
JSON

FAKE_INTERVIEW="$SCRATCH/interview"
cat >"$FAKE_INTERVIEW" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [ "${1:-}" = "--version" ]; then
  printf '0.1.0\n'
  exit 0
fi
printf '%s\n' "$*" >>"$FAKE_INTERVIEW_CALLS"
if [ -n "${FAKE_INTERVIEW_SLEEP:-}" ]; then sleep "$FAKE_INTERVIEW_SLEEP"; fi
result="${FAKE_INTERVIEW_RESULT:-}"
[ -n "$result" ] || result='{"status":"completed","responses":[]}'
printf '%s\n' "$result"
exit "${FAKE_INTERVIEW_EXIT:-0}"
EOF
chmod +x "$FAKE_INTERVIEW"

FAKE_LINEAR="$SCRATCH/linear-cli"
cat >"$FAKE_LINEAR" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"$FAKE_LINEAR_CALLS"
body=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--body" ]; then
    shift
    body="${1:-}"
    break
  fi
  shift
done
printf '%s' "$body" >"$FAKE_LINEAR_BODY"
if [ "${FAKE_LINEAR_FAIL:-0}" = "1" ]; then
  echo "simulated Linear failure" >&2
  exit 1
fi
printf '{"id":"comment-123"}\n'
EOF
chmod +x "$FAKE_LINEAR"

COMMON_ENV=(
  PI_FLEET_INTERVIEW_TEST_MODE=1
  PI_FLEET_INTERVIEW_BIN="$FAKE_INTERVIEW"
  PI_FLEET_LINEAR_BIN="$FAKE_LINEAR"
  PI_FLEET_INTERVIEW_STATE_DIR="$SCRATCH/state"
  PI_FLEET_INTERVIEW_WATCHDOG_GRACE=0
  FAKE_INTERVIEW_CALLS="$SCRATCH/interview.calls"
  FAKE_LINEAR_CALLS="$SCRATCH/linear.calls"
  FAKE_LINEAR_BODY="$SCRATCH/linear.body"
)

if [ -x "$SCRIPT" ]; then
  echo "PASS: wrapper is executable"
  pass=$((pass + 1))
else
  echo "FAIL: wrapper is not executable"
  fail=$((fail + 1))
fi

# Completed direct-browser flow posts before returning success.
: >"$SCRATCH/interview.calls"
: >"$SCRATCH/linear.calls"
OUT="$SCRATCH/completed.json"
RESULT='{"status":"completed","responses":[{"id":"architectural-001","value":"Library"}]}'
rc=0
env "${COMMON_ENV[@]}" FAKE_INTERVIEW_RESULT="$RESULT" \
  "$SCRIPT" run --issue FLT-999 --questions "$QUESTIONS" --output "$OUT" --timeout 3 >/dev/null 2>"$SCRATCH/completed.err" || rc=$?
check "completed flow exits zero" "0" "$rc"
check "completed status" "completed" "$(json_field "$OUT" status)"
check "completed gate opens" "OPEN" "$(json_field "$OUT" decompositionGate)"
contains "direct browser channel is audited" "$OUT" '"channel": "agent-interview-cli/browser"'
contains "pinned CLI receives questions" "$SCRATCH/interview.calls" "$QUESTIONS"
contains "Linear comment targets source spike" "$SCRATCH/linear.calls" "comments create FLT-999"
contains "Linear comment carries audit marker" "$SCRATCH/linear.body" "Spike interview audit · pi-fleet.spike-interview.v1"

# Upstream cancellation keeps its partial answer, posts it, and blocks decomposition.
OUT="$SCRATCH/cancelled.json"
RESULT='{"status":"cancelled","responses":[{"id":"architectural-001","value":"Service"}]}'
rc=0
env "${COMMON_ENV[@]}" FAKE_INTERVIEW_RESULT="$RESULT" FAKE_INTERVIEW_EXIT=1 \
  "$SCRIPT" run --issue FLT-999 --questions "$QUESTIONS" --output "$OUT" --timeout 3 >/dev/null 2>"$SCRATCH/cancelled.err" || rc=$?
check "cancelled flow exits non-zero" "1" "$rc"
check "cancelled status is retained" "cancelled" "$(json_field "$OUT" status)"
check "cancelled gate is blocked" "BLOCKED" "$(json_field "$OUT" decompositionGate)"
contains "cancelled partial answer is posted" "$SCRATCH/linear.body" '"value": "Service"'

# Explicit non-interactive mode skips the browser, posts the full question set, and fails loudly.
: >"$SCRATCH/interview.calls"
OUT="$SCRATCH/unavailable.json"
rc=0
env "${COMMON_ENV[@]}" PI_FLEET_INTERVIEW_NONINTERACTIVE=1 \
  "$SCRIPT" run --issue FLT-999 --questions "$QUESTIONS" --output "$OUT" --timeout 3 >/dev/null 2>"$SCRATCH/unavailable.err" || rc=$?
check "non-interactive fallback exits non-zero" "1" "$rc"
check "non-interactive status" "unavailable" "$(json_field "$OUT" status)"
contains "fallback channel is explicit" "$OUT" '"channel": "linear-comment/fallback"'
check "non-interactive fallback does not invoke browser CLI" "" "$(cat "$SCRATCH/interview.calls")"
contains "non-interactive question set is posted" "$SCRATCH/linear.body" '"id": "architectural-001"'
contains "non-interactive failure is loud" "$SCRATCH/unavailable.err" "decomposition remains BLOCKED"

# A Linear write failure retains the local audit artifact and returns a distinct hard failure.
OUT="$SCRATCH/post-failed.json"
RESULT='{"status":"completed","responses":[{"id":"architectural-001","value":"Library"}]}'
rc=0
env "${COMMON_ENV[@]}" FAKE_INTERVIEW_RESULT="$RESULT" FAKE_LINEAR_FAIL=1 \
  "$SCRIPT" run --issue FLT-999 --questions "$QUESTIONS" --output "$OUT" --timeout 3 >/dev/null 2>"$SCRATCH/post-failed.err" || rc=$?
check "Linear write failure exits two" "2" "$rc"
check "answers survive Linear write failure" "completed" "$(json_field "$OUT" status)"
contains "Linear write failure reports retained artifact" "$SCRATCH/post-failed.err" "Local audit retained at"

# Async fallback answers use the same audit schema and can open the gate only after posting.
RECORDED="$SCRATCH/recorded-result.json"
printf '%s\n' '{"status":"completed","responses":[{"id":"architectural-001","value":"Service"}]}' >"$RECORDED"
OUT="$SCRATCH/recorded.json"
rc=0
env "${COMMON_ENV[@]}" \
  "$SCRIPT" record --issue FLT-999 --questions "$QUESTIONS" --result "$RECORDED" --output "$OUT" >/dev/null 2>"$SCRATCH/recorded.err" || rc=$?
check "recorded fallback exits zero" "0" "$rc"
check "recorded fallback completes" "completed" "$(json_field "$OUT" status)"
contains "recorded fallback channel is audited" "$OUT" '"channel": "linear-comment/fallback"'

# External watchdog covers the upstream no-browser-connect timeout limitation.
OUT="$SCRATCH/timeout.json"
rc=0
env "${COMMON_ENV[@]}" FAKE_INTERVIEW_SLEEP=2 \
  "$SCRIPT" run --issue FLT-999 --questions "$QUESTIONS" --output "$OUT" --timeout 1 >/dev/null 2>"$SCRATCH/timeout.err" || rc=$?
check "watchdog timeout exits non-zero" "1" "$rc"
check "watchdog records timeout" "timeout" "$(json_field "$OUT" status)"
contains "watchdog timeout is posted" "$SCRATCH/linear.body" '"status": "timeout"'

echo "---"
echo "Results: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
