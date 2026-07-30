#!/usr/bin/env bash
# FLT-66 regression guard: ALL primary fleet seats are unattended (no permission ask modals).
#
# Deterministic + non-interactive. Proves for pi-implementer, pi-project-lead, pi-conductor,
# pi-reviewer, pi-ac-verifier:
# 1) Launch argv always includes --approve (no FLEET_YOLO gate).
# 2) Launch argv includes --no-extensions.
# 3) No permission: ask states in agent frontmatter.
# 4) Lead/conductor still omit write/edit from --tools and keep hard secret path denials.
# 5) Implementer keeps write/edit/bash and loads implementer.json (yoloMode + secret denials).
# 6) Lead/conductor still load permission-system + seat policy extensions.
#
# No real model/API call for structural checks: mocks outfitter and inspects argv.
# Optional headless -p probe (when pi is installed) confirms no allow? / permission UI prompts.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FAKE_BIN="$(mktemp -d)"
OUT_DIR="${1:-$DIR/evals/results}"
mkdir -p "$OUT_DIR"
OUT="$OUT_DIR/unattended-all-fleet-seats-latest.txt"
trap 'rm -rf "$FAKE_BIN"' EXIT

cat >"$FAKE_BIN/outfitter" <<'EOF'
#!/usr/bin/env bash
printf 'ARG=%s\n' "$@"
printf 'ENV:FLEET_YOLO=%s\n' "${FLEET_YOLO-}"
printf 'ENV:PI_CODING_AGENT_DIR=%s\n' "${PI_CODING_AGENT_DIR-}"
EOF
chmod +x "$FAKE_BIN/outfitter"

# Mock packages required by restricted seats before they reach outfitter.
mkdir -p "$FAKE_BIN/agent/npm/node_modules/@gotgenes/pi-permission-system"
mkdir -p "$FAKE_BIN/agent/npm/node_modules/pi-subagents"
printf '{}\n' >"$FAKE_BIN/agent/npm/node_modules/pi-subagents/package.json"
printf '// mock\n' >"$FAKE_BIN/agent/npm/node_modules/pi-subagents/index.ts"
# xai oauth optional path for lead/conductor
mkdir -p "$FAKE_BIN/agent/npm/node_modules/pi-xai-oauth/extensions"
touch "$FAKE_BIN/agent/npm/node_modules/pi-xai-oauth/extensions/xai-oauth.ts"

pass=0
fail=0
ok() {
	echo "PASS: $1"
	pass=$((pass + 1))
}
no() {
	echo "FAIL: $1"
	fail=$((fail + 1))
}

contains_line() {
	local desc="$1" expected="$2" output="$3"
	if printf '%s\n' "$output" | grep -Fqx -- "$expected"; then
		ok "$desc"
	else no "$desc (missing: $expected)"; fi
}
contains_any() {
	local desc="$1" pattern="$2" output="$3"
	if printf '%s\n' "$output" | grep -Eq -- "$pattern"; then
		ok "$desc"
	else no "$desc (missing pattern: $pattern)"; fi
}
rejects() {
	local desc="$1" pattern="$2" output="$3"
	if printf '%s\n' "$output" | grep -Eq -- "$pattern"; then
		no "$desc (found: $pattern)"
	else ok "$desc"; fi
}
assert_file_lacks() {
	local desc="$1" file="$2" pattern="$3"
	if python3 - "$DIR/$file" "$pattern" <<'PY'; then
import re, sys
text = open(sys.argv[1], encoding="utf-8").read()
sys.exit(0 if not re.search(sys.argv[2], text, re.MULTILINE | re.DOTALL) else 1)
PY
		ok "$desc"
	else
		no "$desc"
		echo "  unexpected pattern: $pattern in $file"
	fi
}
assert_file_contains() {
	local desc="$1" file="$2" pattern="$3"
	if python3 - "$DIR/$file" "$pattern" <<'PY'; then
import re, sys
text = open(sys.argv[1], encoding="utf-8").read()
sys.exit(0 if re.search(sys.argv[2], text, re.MULTILINE | re.DOTALL) else 1)
PY
		ok "$desc"
	else
		no "$desc"
		echo "  missing pattern: $pattern in $file"
	fi
}
assert_frontmatter_no_ask() {
	local f="$1"
	if python3 - "$DIR/$f" <<'PY'; then
import re, sys
text = open(sys.argv[1], encoding="utf-8").read()
m = re.match(r"^---\n(.*?)\n---\n", text, re.DOTALL)
if not m:
    sys.exit(1)
fm = m.group(1)
if re.search(r"(?m)^\s*(?:[\"']?\*?[\"']?\s*:\s*)?ask\s*$", fm):
    sys.exit(1)
if re.search(r":\s*ask\b", fm):
    sys.exit(1)
sys.exit(0)
PY
		ok "$f has no permission ask state"
	else no "$f has no permission ask state"; fi
}

run_impl() {
	cd /tmp && env -u FLEET_YOLO PATH="$FAKE_BIN:$PATH" \
		PI_CODING_AGENT_DIR="$FAKE_BIN/agent" \
		FLEET_IMPLEMENTER_RUNTIME_DIR="$FAKE_BIN/implementer-runtime" \
		HOME="$FAKE_BIN" \
		"$DIR/bin/pi-implementer" -p 'list files; report TOOL_OK=1'
}
run_lead() {
	cd /tmp && env -u FLEET_YOLO PATH="$FAKE_BIN:$PATH" \
		PI_CODING_AGENT_DIR="$FAKE_BIN/agent" \
		FLEET_PROJECT_LEAD_RUNTIME_DIR="$FAKE_BIN/project-lead-runtime" \
		HOME="$FAKE_BIN" \
		PI_XAI_OAUTH_EXT="$FAKE_BIN/agent/npm/node_modules/pi-xai-oauth/extensions/xai-oauth.ts" \
		"$DIR/bin/pi-project-lead" -p 'list panes; report TOOL_OK=1'
}
run_cond() {
	cd /tmp && env -u FLEET_YOLO PATH="$FAKE_BIN:$PATH" \
		PI_CODING_AGENT_DIR="$FAKE_BIN/agent" \
		FLEET_CONDUCTOR_RUNTIME_DIR="$FAKE_BIN/conductor-runtime" \
		HOME="$FAKE_BIN" \
		PI_XAI_OAUTH_EXT="$FAKE_BIN/agent/npm/node_modules/pi-xai-oauth/extensions/xai-oauth.ts" \
		"$DIR/bin/pi-conductor" -p 'list workspaces; report TOOL_OK=1'
}
run_reviewer() {
	cd /tmp && env -u FLEET_YOLO PATH="$FAKE_BIN:$PATH" \
		PI_CODING_AGENT_DIR="$FAKE_BIN/agent" \
		"$DIR/bin/pi-reviewer" -p 'list files; report TOOL_OK=1'
}
run_ac() {
	cd /tmp && env -u FLEET_YOLO PATH="$FAKE_BIN:$PATH" \
		PI_CODING_AGENT_DIR="$FAKE_BIN/agent" \
		HOME="$FAKE_BIN" \
		"$DIR/bin/pi-ac-verifier" -p 'run git status; report TOOL_OK=1'
}

{
	echo "FLT-66 unattended all fleet seats smoke"
	echo

	echo "1) pi-implementer launch argv (always unattended)"
	impl_out="$(run_impl)"
	contains_line "implementer always passes --approve" "ARG=--approve" "$impl_out"
	contains_line "implementer always passes --no-extensions" "ARG=--no-extensions" "$impl_out"
	contains_line "implementer loads explicit linear extension" "ARG=$DIR/extensions/linear.ts" "$impl_out"
	contains_any "implementer loads permission-system package" \
		'ARG=.*/@gotgenes/pi-permission-system|ARG=.*/pi-permission-system' "$impl_out"
	contains_any "implementer tools keep write/edit/bash" \
		'ARG=read,grep,find,ls,write,edit,bash,' "$impl_out"
	impl_yolo0="$(cd /tmp && env FLEET_YOLO=0 PATH="$FAKE_BIN:$PATH" \
		PI_CODING_AGENT_DIR="$FAKE_BIN/agent" \
		FLEET_IMPLEMENTER_RUNTIME_DIR="$FAKE_BIN/implementer-runtime2" \
		HOME="$FAKE_BIN" \
		"$DIR/bin/pi-implementer" -p noop)"
	contains_line "implementer still --approve when FLEET_YOLO=0" "ARG=--approve" "$impl_yolo0"
	# Overlay pins implementer.json
	if [ -L "$FAKE_BIN/implementer-runtime/agent/extensions/pi-permission-system/config.json" ] && \
		[ "$(readlink "$FAKE_BIN/implementer-runtime/agent/extensions/pi-permission-system/config.json")" = \
			"$DIR/permission-system/implementer.json" ]; then
		ok "implementer runtime pins permission-system/implementer.json"
	else
		no "implementer runtime pins permission-system/implementer.json"
	fi
	assert_file_contains "implementer.json has yoloMode true" "permission-system/implementer.json" \
		'"yoloMode":\s*true'
	assert_file_contains "implementer.json denies .env secrets" "permission-system/implementer.json" \
		'"\*\.env":\s*"deny"'
	assert_file_contains "implementer.json denies .ssh secrets" "permission-system/implementer.json" \
		'"\*\*/\.ssh/\*":\s*"deny"'

	echo
	echo "2) pi-project-lead launch argv (always unattended, no write/edit)"
	lead_out="$(run_lead)"
	contains_line "project-lead always passes --approve" "ARG=--approve" "$lead_out"
	contains_line "project-lead always passes --no-extensions" "ARG=--no-extensions" "$lead_out"
	contains_any "project-lead loads permission-system package" \
		'ARG=.*/@gotgenes/pi-permission-system|ARG=.*/pi-permission-system' "$lead_out"
	contains_line "project-lead loads project-lead-policy" "ARG=$DIR/extensions/project-lead-policy.ts" "$lead_out"
	contains_line "project-lead tools omit write/edit" \
		"ARG=read,grep,find,ls,bash,linear_get_issue,linear_list,linear_comment,linear_update,e2b_cast,e2b_status,e2b_wait,e2b_cancel,e2b_logs,e2b_port_url" "$lead_out"
	rejects "project-lead tools do not grant write/edit" '^ARG=.*(write|edit)' "$lead_out"
	lead_yolo0="$(cd /tmp && env FLEET_YOLO=0 PATH="$FAKE_BIN:$PATH" \
		PI_CODING_AGENT_DIR="$FAKE_BIN/agent" \
		FLEET_PROJECT_LEAD_RUNTIME_DIR="$FAKE_BIN/project-lead-runtime2" \
		HOME="$FAKE_BIN" \
		PI_XAI_OAUTH_EXT="$FAKE_BIN/agent/npm/node_modules/pi-xai-oauth/extensions/xai-oauth.ts" \
		"$DIR/bin/pi-project-lead" -p noop)"
	contains_line "project-lead still --approve when FLEET_YOLO=0" "ARG=--approve" "$lead_yolo0"
	assert_file_contains "project-lead.json has yoloMode true" "permission-system/project-lead.json" \
		'"yoloMode":\s*true'
	assert_file_contains "project-lead.json denies write" "permission-system/project-lead.json" \
		'"write":\s*"deny"'
	assert_file_contains "project-lead.json denies edit" "permission-system/project-lead.json" \
		'"edit":\s*"deny"'
	assert_file_contains "project-lead.json denies .env secrets" "permission-system/project-lead.json" \
		'"\*\.env":\s*"deny"'
	assert_file_contains "project-lead.json denies .ssh secrets" "permission-system/project-lead.json" \
		'"\*\*/\.ssh/\*":\s*"deny"'

	echo
	echo "3) pi-conductor launch argv (always unattended, no write/edit)"
	cond_out="$(run_cond)"
	contains_line "conductor always passes --approve" "ARG=--approve" "$cond_out"
	contains_line "conductor always passes --no-extensions" "ARG=--no-extensions" "$cond_out"
	contains_any "conductor loads permission-system package" \
		'ARG=.*/@gotgenes/pi-permission-system|ARG=.*/pi-permission-system' "$cond_out"
	contains_line "conductor loads conductor-policy" "ARG=$DIR/extensions/conductor-policy.ts" "$cond_out"
	contains_line "conductor tools routing-only (FLT-65) omit write/edit" \
		"ARG=bash,linear_get_issue,linear_list,linear_comment,linear_update" "$cond_out"
	rejects "conductor tools do not grant write/edit" '^ARG=.*(write|edit)' "$cond_out"
	rejects "conductor tools omit product investigation (FLT-65)" '^ARG=.*(read|grep|find|,ls,)' "$cond_out"
	cond_yolo0="$(cd /tmp && env FLEET_YOLO=0 PATH="$FAKE_BIN:$PATH" \
		PI_CODING_AGENT_DIR="$FAKE_BIN/agent" \
		FLEET_CONDUCTOR_RUNTIME_DIR="$FAKE_BIN/conductor-runtime2" \
		HOME="$FAKE_BIN" \
		PI_XAI_OAUTH_EXT="$FAKE_BIN/agent/npm/node_modules/pi-xai-oauth/extensions/xai-oauth.ts" \
		"$DIR/bin/pi-conductor" -p noop)"
	contains_line "conductor still --approve when FLEET_YOLO=0" "ARG=--approve" "$cond_yolo0"
	assert_file_contains "conductor.json has yoloMode true" "permission-system/conductor.json" \
		'"yoloMode":\s*true'
	assert_file_contains "conductor.json denies write" "permission-system/conductor.json" \
		'"write":\s*"deny"'
	assert_file_contains "conductor.json denies edit" "permission-system/conductor.json" \
		'"edit":\s*"deny"'
	assert_file_contains "conductor.json denies .env secrets" "permission-system/conductor.json" \
		'"\*\.env":\s*"deny"'
	assert_file_contains "conductor.json denies .ssh secrets" "permission-system/conductor.json" \
		'"\*\*/\.ssh/\*":\s*"deny"'

	echo
	echo "4) pi-reviewer + pi-ac-verifier remain unattended (FLT-60)"
	rev_out="$(run_reviewer)"
	contains_line "reviewer always passes --approve" "ARG=--approve" "$rev_out"
	contains_line "reviewer always passes --no-extensions" "ARG=--no-extensions" "$rev_out"
	rejects "reviewer does not load permission-system package" \
		'pi-permission-system|@gotgenes/pi-permission-system' "$rev_out"
	ac_out="$(run_ac)"
	contains_line "ac-verifier always passes --approve" "ARG=--approve" "$ac_out"
	contains_line "ac-verifier always passes --no-extensions" "ARG=--no-extensions" "$ac_out"
	rejects "ac-verifier does not load permission-system package" \
		'pi-permission-system|@gotgenes/pi-permission-system' "$ac_out"

	echo
	echo "5) agent frontmatter has no ask gates (primary seats)"
	for f in \
		agents/implementer.md \
		agents/project-lead.md \
		agents/conductor.md \
		agents/reviewer.md \
		agents/ac-verifier.md \
		agents/ac-criterion-verifier.md; do
		assert_frontmatter_no_ask "$f"
	done

	echo
	echo "6) wrappers do not gate --approve on FLEET_YOLO (always-on)"
	# Only the assignment gate form counts — comments may mention FLEET_YOLO + --approve.
	assert_file_lacks "pi-implementer does not gate --approve on FLEET_YOLO" "bin/pi-implementer" \
		'\[ "\$\{FLEET_YOLO:-\}" = "1" \] && YOLO="--approve"|YOLO=""\s*\n\[ "\$\{FLEET_YOLO'
	assert_file_lacks "pi-project-lead does not gate --approve on FLEET_YOLO" "bin/pi-project-lead" \
		'\[ "\$\{FLEET_YOLO:-\}" = "1" \] && YOLO="--approve"|YOLO=""\s*\n\[ "\$\{FLEET_YOLO'
	assert_file_lacks "pi-conductor does not gate --approve on FLEET_YOLO" "bin/pi-conductor" \
		'\[ "\$\{FLEET_YOLO:-\}" = "1" \] && YOLO="--approve"|YOLO=""\s*\n\[ "\$\{FLEET_YOLO'
	assert_file_contains "pi-implementer hardcodes --approve" "bin/pi-implementer" '--approve'
	assert_file_contains "pi-project-lead hardcodes --approve" "bin/pi-project-lead" '--approve'
	assert_file_contains "pi-conductor hardcodes --approve" "bin/pi-conductor" '--approve'

	echo
	echo "7) headless -p smoke: no allow? / permission UI prompts (when pi installed)"
	if command -v pi >/dev/null 2>&1; then
		probe_log="$FAKE_BIN/tool-probe.log"
		# Use a throwaway agent overlay with implementer.json so PS is yolo + deny-secrets.
		probe_agent="$FAKE_BIN/probe-agent"
		mkdir -p "$probe_agent/extensions/pi-permission-system"
		ln -sfn "$DIR/permission-system/implementer.json" \
			"$probe_agent/extensions/pi-permission-system/config.json"
		# Link auth if present so the model can answer; soft-fail if unavailable.
		if [ -f "${HOME}/.pi/agent/auth.json" ]; then
			ln -sfn "${HOME}/.pi/agent/auth.json" "$probe_agent/auth.json"
		fi
		PS_PKG="${HOME}/.pi/agent/npm/node_modules/@gotgenes/pi-permission-system"
		if [ -d "$PS_PKG" ]; then
			rm -f "$probe_log"
			if perl -e 'alarm shift; exec @ARGV' 60 \
				env PI_CODING_AGENT_DIR="$probe_agent" \
				pi --no-extensions --approve \
				--extension "$PS_PKG" \
				--tools read,grep,find,ls,bash \
				-p "Run exactly: printf TOOL_RAN=1. Reply with TOOL_DONE only. Do not ask for permission." \
				</dev/null >"$probe_log" 2>&1; then
				:
			fi
			if grep -qiE 'permission.*(ask|prompt|required)|Allow this bash|permissions:ui_prompt|\[y/N\]|approve this' "$probe_log" 2>/dev/null; then
				no "headless -p probe hit a permission prompt"
				echo "  log tail:"
				tail -30 "$probe_log" | sed 's/^/  /'
			else
				ok "headless -p probe emitted no permission ask prompt"
			fi
		else
			ok "permission-system package not installed; skipped live PS probe"
		fi
	else
		ok "pi binary not installed; skipped live headless -p probe"
	fi

	echo
	echo "---"
	echo "$pass passed, $fail failed"
	if [ "$fail" -eq 0 ]; then
		echo "VERDICT: PASS"
	else
		echo "VERDICT: FAIL"
	fi
} | tee "$OUT"

exit "$fail"
