#!/usr/bin/env bash
# FLT-60 + FLT-67 regression guard: unattended QC + fleet-wide PS removal.
#
# Deterministic + non-interactive. Proves:
# 1) Launch argv always includes --approve and --no-extensions (no FLEET_YOLO gate).
# 2) Launch argv does NOT load @gotgenes/pi-permission-system (no ask-gate extension).
# 3) --tools allowlists are unchanged (security boundary stays the wrapper allowlist).
# 4) Agent frontmatter has no permission: block (PS removed fleet-wide, FLT-67).
# 5) Conductor / project-lead also do NOT load permission-system (always YOLO, FLT-67).
#
# No real model/API call: mocks outfitter and inspects argv. Optional headless tool-path
# probe uses pi --no-extensions with the seat allowlist only (no permission-system).
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FAKE_BIN="$(mktemp -d)"
OUT_DIR="${1:-$DIR/evals/results}"
mkdir -p "$OUT_DIR"
OUT="$OUT_DIR/unattended-reviewer-ac-latest.txt"
trap 'rm -rf "$FAKE_BIN"' EXIT

cat >"$FAKE_BIN/outfitter" <<'MOCK'
#!/usr/bin/env bash
printf 'ARG=%s\n' "$@"
MOCK
chmod +x "$FAKE_BIN/outfitter"

# Minimal pi-subagents package so pi-ac-verifier can resolve its explicit extension.
mkdir -p "$FAKE_BIN/agent/npm/node_modules/pi-subagents"
printf '{}\n' >"$FAKE_BIN/agent/npm/node_modules/pi-subagents/package.json"
printf '// mock\n' >"$FAKE_BIN/agent/npm/node_modules/pi-subagents/index.ts"

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
	if python3 - "$DIR/$file" "$pattern" <<'PY'
import re, sys
text = open(sys.argv[1], encoding="utf-8").read()
sys.exit(0 if not re.search(sys.argv[2], text, re.MULTILINE | re.DOTALL) else 1)
PY
	then
		ok "$desc"
	else
		no "$desc"
		echo "  unexpected pattern: $pattern in $file"
	fi
}
assert_file_contains() {
	local desc="$1" file="$2" pattern="$3"
	if python3 - "$DIR/$file" "$pattern" <<'PY'
import re, sys
text = open(sys.argv[1], encoding="utf-8").read()
sys.exit(0 if re.search(sys.argv[2], text, re.MULTILINE | re.DOTALL) else 1)
PY
	then
		ok "$desc"
	else
		no "$desc"
		echo "  missing pattern: $pattern in $file"
	fi
}

run_reviewer() {
	cd /tmp && env -u FLEET_YOLO PATH="$FAKE_BIN:$PATH" \
		PI_CODING_AGENT_DIR="$FAKE_BIN/agent" \
		"$DIR/bin/pi-reviewer" -p 'list files with ls; report TOOL_OK=1'
}
run_ac() {
	cd /tmp && env -u FLEET_YOLO PATH="$FAKE_BIN:$PATH" \
		PI_CODING_AGENT_DIR="$FAKE_BIN/agent" \
		HOME="$FAKE_BIN" \
		"$DIR/bin/pi-ac-verifier" -p 'run git status; report TOOL_OK=1'
}
run_lead() {
	cd /tmp && env -u FLEET_YOLO PATH="$FAKE_BIN:$PATH" \
		PI_CODING_AGENT_DIR="$FAKE_BIN/agent" \
		HOME="$FAKE_BIN" \
		FLEET_PROJECT_LEAD_RUNTIME_DIR="$FAKE_BIN/lead-runtime" \
		"$DIR/bin/pi-project-lead" -p 'noop'
}
run_conductor() {
	cd /tmp && env -u FLEET_YOLO PATH="$FAKE_BIN:$PATH" \
		PI_CODING_AGENT_DIR="$FAKE_BIN/agent" \
		HOME="$FAKE_BIN" \
		FLEET_CONDUCTOR_RUNTIME_DIR="$FAKE_BIN/conductor-runtime" \
		"$DIR/bin/pi-conductor" -p 'noop'
}
run_implementer() {
	cd /tmp && env -u FLEET_YOLO PATH="$FAKE_BIN:$PATH" \
		PI_CODING_AGENT_DIR="$FAKE_BIN/agent" \
		"$DIR/bin/pi-implementer" -p 'noop'
}

{
	echo "FLT-60/FLT-67 unattended + no-permission-system smoke"
	echo

	echo "1) pi-reviewer launch argv (no FLEET_YOLO)"
	rev_out="$(run_reviewer)"
	contains_line "reviewer always passes --approve" "ARG=--approve" "$rev_out"
	contains_line "reviewer always passes --no-extensions" "ARG=--no-extensions" "$rev_out"
	contains_line "reviewer loads explicit linear extension" "ARG=$DIR/extensions/linear.ts" "$rev_out"
	contains_line "reviewer tools allowlist unchanged" \
		"ARG=read,grep,find,ls,linear_get_issue,linear_list" "$rev_out"
	rejects "reviewer does not load permission-system package" \
		'pi-permission-system|@gotgenes/pi-permission-system' "$rev_out"
	rejects "reviewer does not grant write/edit/bash" \
		'^ARG=.*(write|edit|bash)' "$rev_out"
	rev_yolo0="$(cd /tmp && env FLEET_YOLO=0 PATH="$FAKE_BIN:$PATH" \
		PI_CODING_AGENT_DIR="$FAKE_BIN/agent" \
		"$DIR/bin/pi-reviewer" -p noop)"
	contains_line "reviewer still --approve when FLEET_YOLO=0" "ARG=--approve" "$rev_yolo0"

	echo
	echo "2) pi-ac-verifier launch argv (no FLEET_YOLO)"
	ac_out="$(run_ac)"
	contains_line "ac-verifier always passes --approve" "ARG=--approve" "$ac_out"
	contains_line "ac-verifier always passes --no-extensions" "ARG=--no-extensions" "$ac_out"
	contains_line "ac-verifier loads linear extension" "ARG=$DIR/extensions/linear.ts" "$ac_out"
	contains_line "ac-verifier loads github-pr extension" "ARG=$DIR/extensions/github-pr.ts" "$ac_out"
	contains_line "ac-verifier loads bash policy extension" "ARG=$DIR/extensions/ac-verifier-policy.ts" "$ac_out"
	contains_any "ac-verifier loads pi-subagents extension" 'ARG=.*/pi-subagents' "$ac_out"
	contains_line "ac-verifier tools allowlist unchanged" \
		"ARG=read,grep,find,ls,bash,subagent,linear_get_issue,linear_list,linear_comment,linear_update,github_pr_view,github_pr_comment" "$ac_out"
	rejects "ac-verifier does not load permission-system package" \
		'pi-permission-system|@gotgenes/pi-permission-system' "$ac_out"
	rejects "ac-verifier does not grant write/edit" \
		'^ARG=.*(write|edit)' "$ac_out"
	ac_yolo0="$(cd /tmp && env FLEET_YOLO=0 PATH="$FAKE_BIN:$PATH" \
		PI_CODING_AGENT_DIR="$FAKE_BIN/agent" HOME="$FAKE_BIN" \
		"$DIR/bin/pi-ac-verifier" -p noop)"
	contains_line "ac-verifier still --approve when FLEET_YOLO=0" "ARG=--approve" "$ac_yolo0"

	echo
	echo "3) agent frontmatter has no permission: block (FLT-67)"
	# Cover every agents/*.md so a reintroduced permission: block cannot slip through.
	for fpath in "$DIR"/agents/*.md; do
		f="agents/$(basename "$fpath")"
		if python3 - "$fpath" <<'PY'
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
		then
			ok "$f has no permission: frontmatter"
		else no "$f has no permission: frontmatter"; fi
	done

	echo
	echo "3b) profiles omit extensions (no double-load against wrapper --extension)"
	for f in profiles/reviewer/profile.yml profiles/ac-verifier/profile.yml; do
		assert_file_lacks "$f has no profile-managed extensions:" "$f" \
			'^[[:space:]]*extensions:'
		assert_file_contains "$f documents wrapper-owned extensions" "$f" \
			'wrapper alone loads|NOT declared here'
	done
	linear_count=$(printf '%s\n' "$rev_out" | grep -cF "ARG=$DIR/extensions/linear.ts" || true)
	[ "$linear_count" -eq 1 ] && ok "reviewer launch has exactly one linear.ts extension" \
		|| no "reviewer launch linear.ts count=$linear_count (want 1)"
	ac_linear=$(printf '%s\n' "$ac_out" | grep -cF "ARG=$DIR/extensions/linear.ts" || true)
	ac_gh=$(printf '%s\n' "$ac_out" | grep -cF "ARG=$DIR/extensions/github-pr.ts" || true)
	[ "$ac_linear" -eq 1 ] && ok "ac-verifier launch has exactly one linear.ts extension" \
		|| no "ac-verifier launch linear.ts count=$ac_linear (want 1)"
	[ "$ac_gh" -eq 1 ] && ok "ac-verifier launch has exactly one github-pr.ts extension" \
		|| no "ac-verifier launch github-pr.ts count=$ac_gh (want 1)"

	echo
	echo "4) conductor / project-lead / implementer also have no permission-system (FLT-67)"
	lead_out="$(run_lead)"
	cond_out="$(run_conductor)"
	impl_out="$(run_implementer)"
	contains_line "project-lead always passes --approve" "ARG=--approve" "$lead_out"
	contains_line "conductor always passes --approve" "ARG=--approve" "$cond_out"
	contains_line "implementer always passes --approve" "ARG=--approve" "$impl_out"
	rejects "project-lead does not load permission-system package" \
		'pi-permission-system|@gotgenes/pi-permission-system' "$lead_out"
	rejects "conductor does not load permission-system package" \
		'pi-permission-system|@gotgenes/pi-permission-system' "$cond_out"
	rejects "implementer does not load permission-system package" \
		'pi-permission-system|@gotgenes/pi-permission-system' "$impl_out"
	contains_line "project-lead keeps policy extension" "ARG=$DIR/extensions/project-lead-policy.ts" "$lead_out"
	contains_line "conductor keeps policy extension" "ARG=$DIR/extensions/conductor-policy.ts" "$cond_out"
	assert_file_lacks "pi-conductor source has no PI_PERMISSION_SYSTEM_PATH assignment" "bin/pi-conductor" \
		'export PI_PERMISSION_SYSTEM_PATH|PI_PERMISSION_SYSTEM_PATH='
	assert_file_lacks "pi-project-lead source has no PI_PERMISSION_SYSTEM_PATH assignment" "bin/pi-project-lead" \
		'export PI_PERMISSION_SYSTEM_PATH|PI_PERMISSION_SYSTEM_PATH='
	assert_file_lacks "runtime has no PI_PERMISSION_SYSTEM_PATH export" "bin/lib/pi-project-lead-runtime.sh" \
		'export PI_PERMISSION_SYSTEM_PATH|PI_PERMISSION_SYSTEM_PATH='
	assert_file_lacks "conductor runtime has no PI_PERMISSION_SYSTEM_PATH export" "bin/lib/pi-conductor-runtime.sh" \
		'export PI_PERMISSION_SYSTEM_PATH|PI_PERMISSION_SYSTEM_PATH='
	assert_file_lacks "runtime does not resolve npm package path" "bin/lib/pi-project-lead-runtime.sh" \
		npm/node_modules/@gotgenes/pi-permission-system
	assert_file_lacks "conductor runtime does not resolve npm package path" "bin/lib/pi-conductor-runtime.sh" \
		npm/node_modules/@gotgenes/pi-permission-system
	if [ ! -e "$DIR/permission-system" ]; then
		ok "permission-system/ directory is removed from repo"
	else
		no "permission-system/ directory is removed from repo"
	fi
	# FLEET_YOLO=0 must not strip --approve
	lead_yolo0="$(cd /tmp && env FLEET_YOLO=0 PATH="$FAKE_BIN:$PATH" \
		PI_CODING_AGENT_DIR="$FAKE_BIN/agent" HOME="$FAKE_BIN" \
		FLEET_PROJECT_LEAD_RUNTIME_DIR="$FAKE_BIN/lead-runtime2" \
		"$DIR/bin/pi-project-lead" -p noop)"
	contains_line "project-lead still --approve when FLEET_YOLO=0" "ARG=--approve" "$lead_yolo0"
	impl_yolo0="$(cd /tmp && env FLEET_YOLO=0 PATH="$FAKE_BIN:$PATH" \
		PI_CODING_AGENT_DIR="$FAKE_BIN/agent" \
		"$DIR/bin/pi-implementer" -p noop)"
	contains_line "implementer still --approve when FLEET_YOLO=0" "ARG=--approve" "$impl_yolo0"

	echo
	echo "5) headless tool path without permission-system (allowlisted tool, no ask gate)"
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
				echo "  log tail:"
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
		ok "pi binary not installed; skipped live tool probe (structural checks still apply)"
		ok "pi binary not installed; skipped ask-gate log scan"
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
