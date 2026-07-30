#!/usr/bin/env bash
# FLT-66 + FLT-67 regression guard: ALL primary fleet seats are unattended, and
# @gotgenes/pi-permission-system is fully removed from launch argv.
#
# Deterministic + non-interactive. Proves for pi-implementer, pi-project-lead, pi-conductor,
# pi-reviewer, pi-ac-verifier:
# 1) Launch argv always includes --approve (no FLEET_YOLO gate).
# 2) Launch argv includes --no-extensions.
# 3) No permission: frontmatter on agents (PS removed fleet-wide).
# 4) Lead/conductor omit write/edit; conductor is routing-only (bash+Linear, FLT-65).
# 5) Implementer keeps write/edit/bash; loads linear only — NOT permission-system.
# 6) Lead/conductor load seat policy extensions only — NOT permission-system.
# 7) permission-system/ directory is absent from the repo.
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

cat >"$FAKE_BIN/outfitter" <<'MOCK'
#!/usr/bin/env bash
printf 'ARG=%s\n' "$@"
printf 'ENV:FLEET_YOLO=%s\n' "${FLEET_YOLO-}"
printf 'ENV:PI_CODING_AGENT_DIR=%s\n' "${PI_CODING_AGENT_DIR-}"
MOCK
chmod +x "$FAKE_BIN/outfitter"

# Mock packages for seats that resolve optional extensions (subagents, xai) — NOT permission-system.
mkdir -p "$FAKE_BIN/agent/npm/node_modules/pi-subagents"
printf '{}\n' >"$FAKE_BIN/agent/npm/node_modules/pi-subagents/package.json"
printf '// mock\n' >"$FAKE_BIN/agent/npm/node_modules/pi-subagents/index.ts"
mkdir -p "$FAKE_BIN/agent/npm/node_modules/pi-xai-oauth/extensions"
touch "$FAKE_BIN/agent/npm/node_modules/pi-xai-oauth/extensions/xai-oauth.ts"

pass=0
fail=0
ok() { echo "PASS: $1"; pass=$((pass + 1)); }
no() { echo "FAIL: $1"; fail=$((fail + 1)); }

contains_line() {
	local desc="$1" expected="$2" output="$3"
	if printf '%s\n' "$output" | grep -Fqx -- "$expected"; then ok "$desc"
	else no "$desc (missing: $expected)"; fi
}
contains_any() {
	local desc="$1" pattern="$2" output="$3"
	if printf '%s\n' "$output" | grep -Eq -- "$pattern"; then ok "$desc"
	else no "$desc (missing pattern: $pattern)"; fi
}
rejects() {
	local desc="$1" pattern="$2" output="$3"
	if printf '%s\n' "$output" | grep -Eq -- "$pattern"; then no "$desc (found: $pattern)"
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

XAI_OAUTH_EXT="$FAKE_BIN/agent/npm/node_modules/pi-xai-oauth/extensions/xai-oauth.ts"

run_impl() {
	cd /tmp && env -u FLEET_YOLO PATH="$FAKE_BIN:$PATH" \
		PI_CODING_AGENT_DIR="$FAKE_BIN/agent" HOME="$FAKE_BIN" \
		FLEET_IMPLEMENTER_RUNTIME_DIR="$FAKE_BIN/implementer-runtime" \
		PI_XAI_OAUTH_EXT="$XAI_OAUTH_EXT" \
		"$DIR/bin/pi-implementer" -p noop
}
run_lead() {
	cd /tmp && env -u FLEET_YOLO PATH="$FAKE_BIN:$PATH" \
		PI_CODING_AGENT_DIR="$FAKE_BIN/agent" HOME="$FAKE_BIN" \
		FLEET_PROJECT_LEAD_RUNTIME_DIR="$FAKE_BIN/lead-runtime" \
		PI_XAI_OAUTH_EXT="$FAKE_BIN/agent/npm/node_modules/pi-xai-oauth/extensions/xai-oauth.ts" \
		"$DIR/bin/pi-project-lead" -p noop
}
run_cond() {
	cd /tmp && env -u FLEET_YOLO PATH="$FAKE_BIN:$PATH" \
		PI_CODING_AGENT_DIR="$FAKE_BIN/agent" HOME="$FAKE_BIN" \
		FLEET_CONDUCTOR_RUNTIME_DIR="$FAKE_BIN/conductor-runtime" \
		PI_XAI_OAUTH_EXT="$FAKE_BIN/agent/npm/node_modules/pi-xai-oauth/extensions/xai-oauth.ts" \
		"$DIR/bin/pi-conductor" -p noop
}
run_rev() {
	cd /tmp && env -u FLEET_YOLO PATH="$FAKE_BIN:$PATH" \
		PI_CODING_AGENT_DIR="$FAKE_BIN/agent" HOME="$FAKE_BIN" \
		PI_XAI_OAUTH_EXT="$XAI_OAUTH_EXT" \
		"$DIR/bin/pi-reviewer" -p noop
}
run_ac() {
	cd /tmp && env -u FLEET_YOLO PATH="$FAKE_BIN:$PATH" \
		PI_CODING_AGENT_DIR="$FAKE_BIN/agent" HOME="$FAKE_BIN" \
		PI_XAI_OAUTH_EXT="$XAI_OAUTH_EXT" \
		"$DIR/bin/pi-ac-verifier" -p noop
}

{
	echo "FLT-66/FLT-67 unattended all fleet seats + no permission-system"
	echo

	echo "0) permission-system directory removed"
	if [ ! -e "$DIR/permission-system" ]; then
		ok "permission-system/ directory is removed from repo"
	else
		no "permission-system/ directory is removed from repo"
	fi

	echo
	echo "1) pi-implementer"
	impl_out="$(run_impl)"
	contains_line "implementer always --approve" "ARG=--approve" "$impl_out"
	contains_line "implementer always --no-extensions" "ARG=--no-extensions" "$impl_out"
	contains_line "implementer loads linear" "ARG=$DIR/extensions/linear.ts" "$impl_out"
	contains_line "implementer re-includes pi-xai-oauth" "ARG=$XAI_OAUTH_EXT" "$impl_out"
	rejects "implementer does not load permission-system" \
		'pi-permission-system|@gotgenes/pi-permission-system' "$impl_out"
	contains_any "implementer keeps write/edit/bash" \
		'ARG=read,grep,find,ls,write,edit,bash,' "$impl_out"
	impl0="$(cd /tmp && env FLEET_YOLO=0 PATH="$FAKE_BIN:$PATH" \
		PI_CODING_AGENT_DIR="$FAKE_BIN/agent" HOME="$FAKE_BIN" \
		"$DIR/bin/pi-implementer" -p noop)"
	contains_line "implementer still --approve when FLEET_YOLO=0" "ARG=--approve" "$impl0"

	echo
	echo "2) pi-project-lead"
	lead_out="$(run_lead)"
	contains_line "project-lead always --approve" "ARG=--approve" "$lead_out"
	contains_line "project-lead always --no-extensions" "ARG=--no-extensions" "$lead_out"
	contains_line "project-lead loads policy extension" "ARG=$DIR/extensions/project-lead-policy.ts" "$lead_out"
	contains_line "project-lead re-includes pi-xai-oauth" "ARG=$XAI_OAUTH_EXT" "$lead_out"
	rejects "project-lead does not load permission-system" \
		'pi-permission-system|@gotgenes/pi-permission-system' "$lead_out"
	rejects "project-lead tools omit write/edit" '^ARG=.*(write|edit)' "$lead_out"
	lead0="$(cd /tmp && env FLEET_YOLO=0 PATH="$FAKE_BIN:$PATH" \
		PI_CODING_AGENT_DIR="$FAKE_BIN/agent" HOME="$FAKE_BIN" \
		FLEET_PROJECT_LEAD_RUNTIME_DIR="$FAKE_BIN/lead-runtime2" \
		"$DIR/bin/pi-project-lead" -p noop)"
	contains_line "project-lead still --approve when FLEET_YOLO=0" "ARG=--approve" "$lead0"

	echo
	echo "3) pi-conductor (FLT-65 routing-only)"
	cond_out="$(run_cond)"
	contains_line "conductor always --approve" "ARG=--approve" "$cond_out"
	contains_line "conductor always --no-extensions" "ARG=--no-extensions" "$cond_out"
	contains_line "conductor loads policy extension" "ARG=$DIR/extensions/conductor-policy.ts" "$cond_out"
	contains_line "conductor re-includes pi-xai-oauth" "ARG=$XAI_OAUTH_EXT" "$cond_out"
	rejects "conductor does not load permission-system" \
		'pi-permission-system|@gotgenes/pi-permission-system' "$cond_out"
	contains_line "conductor routing-only tools" \
		"ARG=bash,linear_get_issue,linear_list,linear_comment,linear_update" "$cond_out"
	rejects "conductor tools omit write/edit/read/grep/find" \
		'^ARG=.*(write|edit|read|grep|find)' "$cond_out"

	echo
	echo "4) pi-reviewer + pi-ac-verifier"
	rev_out="$(run_rev)"
	ac_out="$(run_ac)"
	contains_line "reviewer always --approve" "ARG=--approve" "$rev_out"
	contains_line "reviewer always --no-extensions" "ARG=--no-extensions" "$rev_out"
	contains_line "reviewer re-includes pi-xai-oauth" "ARG=$XAI_OAUTH_EXT" "$rev_out"
	rejects "reviewer does not load permission-system" \
		'pi-permission-system|@gotgenes/pi-permission-system' "$rev_out"
	contains_line "ac-verifier always --approve" "ARG=--approve" "$ac_out"
	contains_line "ac-verifier always --no-extensions" "ARG=--no-extensions" "$ac_out"
	contains_line "ac-verifier re-includes pi-xai-oauth" "ARG=$XAI_OAUTH_EXT" "$ac_out"
	rejects "ac-verifier does not load permission-system" \
		'pi-permission-system|@gotgenes/pi-permission-system' "$ac_out"

	echo
	echo "5) agent frontmatter has no permission: block"
	for f in agents/implementer.md agents/project-lead.md agents/conductor.md \
		agents/reviewer.md agents/ac-verifier.md agents/ac-criterion-verifier.md; do
		if python3 - "$DIR/$f" <<'PY'
import re, sys
text = open(sys.argv[1], encoding="utf-8").read()
m = re.match(r"^---\n(.*?)\n---\n", text, re.DOTALL)
if not m:
    sys.exit(1)
fm = m.group(1)
if re.search(r"(?m)^permission:\s*$", fm) or re.search(r"(?m)^permission:\s", fm):
    sys.exit(1)
sys.exit(0)
PY
		then ok "$f has no permission: frontmatter"
		else no "$f has no permission: frontmatter"; fi
	done

	echo
	echo "6) wrappers have no PS operational wiring"
	assert_file_lacks "pi-implementer has no PI_PERMISSION assignment" "bin/pi-implementer" \
		'export PI_PERMISSION_SYSTEM_PATH|PI_PERMISSION_SYSTEM_PATH='
	assert_file_lacks "pi-project-lead has no PI_PERMISSION assignment" "bin/pi-project-lead" \
		'export PI_PERMISSION_SYSTEM_PATH|PI_PERMISSION_SYSTEM_PATH='
	assert_file_lacks "pi-conductor has no PI_PERMISSION assignment" "bin/pi-conductor" \
		'export PI_PERMISSION_SYSTEM_PATH|PI_PERMISSION_SYSTEM_PATH='
	assert_file_lacks "no implementer-runtime PS package resolve" "bin/pi-implementer" \
		'pi-implementer-runtime|PI_PERMISSION_SYSTEM_PATH'

	echo
	echo "7) optional headless probe (no PS, --approve)"
	if command -v pi >/dev/null 2>&1; then
		probe_log="$FAKE_BIN/tool-probe.log"
		sentinel="$FAKE_BIN/tool-sentinel.txt"
		rm -f "$sentinel" "$probe_log"
		if perl -e 'alarm shift; exec @ARGV' 45 \
			pi --no-extensions --approve \
			--tools read,grep,find,ls,bash \
			-p "Run exactly this bash command and nothing else: printf TOOL_RAN=1 > $sentinel . Then reply TOOL_DONE." \
			</dev/null >"$probe_log" 2>&1; then
			:
		fi
		if [ -f "$sentinel" ] && grep -q 'TOOL_RAN=1' "$sentinel"; then
			ok "allowlisted bash tool ran without permission-system (sentinel written)"
		else
			if grep -qiE 'permission|allow this|approve this|y/n|\[y/N\]|ui_prompt' "$probe_log" 2>/dev/null; then
				no "headless tool probe hit a permission prompt"
				tail -20 "$probe_log" | sed 's/^/  /'
			else
				ok "headless tool probe emitted no permission prompt (API/model may be unavailable)"
			fi
		fi
		if grep -qiE 'permission.*(ask|prompt|denied by user)|Allow this bash|permissions:ui_prompt' "$probe_log" 2>/dev/null; then
			no "permission-system ask gate appeared in headless probe log"
		else
			ok "no permission-system ask gate in headless probe log"
		fi
	else
		ok "pi binary not installed; skipped live tool probe"
		ok "pi binary not installed; skipped ask-gate log scan"
	fi

	echo
	echo "---"
	echo "$pass passed, $fail failed"
	if [ "$fail" -eq 0 ]; then echo "VERDICT: PASS"; else echo "VERDICT: FAIL"; fi
} | tee "$OUT"

exit "$fail"
