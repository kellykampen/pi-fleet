#!/usr/bin/env bash
# FLT-15 regression guard for Linear extension pathing.
#
# Outfitter/Pi currently pass profile-managed `extensions:` through as literal `--extension`
# values. Unlike skills, those relative extension paths are not anchored to profile.yml/source-root;
# they resolve from the process launch cwd. Fleet seats that must launch from arbitrary project
# directories therefore resolve repo-local extensions in wrappers, from the wrapper's own location.
#
# This smoke is deterministic and non-interactive: it shadows `outfitter` with a tiny argv printer,
# launches wrappers from several cwds, and audits profile YAML for portable (non-machine-specific)
# Linear extension references where profiles still own them.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FAKE_BIN="$(mktemp -d)"
FAKE_HOME="$(mktemp -d)"
trap 'rm -rf "$FAKE_BIN" "$FAKE_HOME"' EXIT

# pi-conductor and pi-project-lead runtimes hard-require @gotgenes/pi-permission-system under the
# resolved agent dir before they will run at all. Stub a resolvable package dir under this
# sandbox's HOME so the wrappers can complete setup here rather than failing on a precondition
# this smoke test isn't exercising.
mkdir -p "$FAKE_HOME/.pi/agent/npm/node_modules/@gotgenes/pi-permission-system"

cat >"$FAKE_BIN/outfitter" <<'EOF'
#!/usr/bin/env bash
printf 'ENV:FLEET_YOLO=%s\n' "${FLEET_YOLO-}"
printf 'ENV:E2B_API_KEY=%s\n' "${E2B_API_KEY-}"
printf 'ENV:FLEET_GITHUB_TOKEN=%s\n' "${FLEET_GITHUB_TOKEN-}"
printf 'ENV:GH_TOKEN=%s\n' "${GH_TOKEN-}"
printf 'ENV:OPENAI_API_KEY=%s\n' "${OPENAI_API_KEY-}"
printf 'ENV:PI_AGENT_AUTH_JSON_B64=%s\n' "${PI_AGENT_AUTH_JSON_B64-}"
printf 'ENV:FLEET_GITHUB_APP_ID=%s\n' "${FLEET_GITHUB_APP_ID-}"
printf 'ENV:FLEET_CONVEX_TOKEN=%s\n' "${FLEET_CONVEX_TOKEN-}"
printf '%s\n' "$@"
EOF
chmod +x "$FAKE_BIN/outfitter"
mkdir -p "$FAKE_HOME/.pi-fleet/secrets" "$FAKE_HOME/.pi/fleet"
chmod 700 "$FAKE_HOME/.pi-fleet" "$FAKE_HOME/.pi-fleet/secrets"
printf 'FLEET_YOLO=1\nE2B_API_KEY=canonical-key\nFLEET_GITHUB_TOKEN=canonical-token\nGH_TOKEN=github-oauth-token\nOPENAI_API_KEY=model-key\nPI_AGENT_AUTH_JSON_B64=oauth-json-b64\nFLEET_GITHUB_APP_ID=12345\nFLEET_CONVEX_TOKEN=convex-token\n' >"$FAKE_HOME/.pi-fleet/secrets/secrets.env"
chmod 600 "$FAKE_HOME/.pi-fleet/secrets/secrets.env"
printf 'E2B_API_KEY=legacy-must-not-load\n' >"$FAKE_HOME/.pi/fleet/secrets.env"
chmod 600 "$FAKE_HOME/.pi/fleet/secrets.env"

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
check() {
	local desc="$1" expected="$2" actual="$3"
	if [ "$expected" = "$actual" ]; then
		ok "$desc"
	else
		no "$desc"
		echo "  expected: $(printf '%q' "$expected")"
		echo "  actual:   $(printf '%q' "$actual")"
	fi
}

extract_extension_args() {
	awk '/^--extension$/ { getline; print }'
}

run_wrapper_from() {
	local wrapper="$1" cwd="$2"
	(cd "$cwd" && env -u FLEET_YOLO -u E2B_API_KEY -u FLEET_GITHUB_TOKEN -u GH_TOKEN \
		-u OPENAI_API_KEY -u PI_AGENT_AUTH_JSON_B64 -u FLEET_GITHUB_APP_ID -u FLEET_CONVEX_TOKEN HOME="$FAKE_HOME" \
		PI_FLEET_HOME="$FAKE_HOME/.pi-fleet" PI_SCHEDULER_TASKS_FILE="$FAKE_HOME/tasks.json" \
		PI_SCHEDULER_TASKS_BOUNDARY="$FAKE_HOME" \
		FLEET_CONDUCTOR_RUNTIME_DIR="$FAKE_HOME/conductor-runtime" \
		FLEET_PROJECT_LEAD_RUNTIME_DIR="$FAKE_HOME/project-lead-runtime" \
		PATH="$FAKE_BIN:$PATH" "$wrapper" --print "hi")
}

assert_wrapper_linear_extension() {
	local name="$1"
	local wrapper="$DIR/bin/$name"
	if [ -x "$wrapper" ]; then ok "$name wrapper is executable"; else no "$name wrapper is not executable"; fi
	for cwd in "$DIR" "$HOME" /tmp; do
		local out extensions linear_path
		out="$(run_wrapper_from "$wrapper" "$cwd")"
		extensions="$(printf '%s\n' "$out" | extract_extension_args)"
		linear_path="$(printf '%s\n' "$extensions" | grep '/extensions/linear\.ts$' | head -1 || true)"
		check "$name passes repo-local linear.ts extension when launched from $cwd" \
			"$DIR/extensions/linear.ts" "$linear_path"
		if [ -e "$linear_path" ]; then ok "$name resolved linear.ts exists on disk"; else no "$name resolved linear.ts missing: $linear_path"; fi
	done
}

assert_no_profile_extensions() {
	local profile="$1"
	local path="$DIR/profiles/$profile/profile.yml"
	if grep -q '^    extensions:' "$path"; then
		no "profiles/$profile/profile.yml omits cwd-sensitive profile-managed extensions"
	else
		ok "profiles/$profile/profile.yml omits cwd-sensitive profile-managed extensions"
	fi
}

assert_profile_repo_relative_linear_extension() {
	local profile="$1"
	local path="$DIR/profiles/$profile/profile.yml"
	local expected='../extensions/linear.ts'
	if grep -q -- "- $expected" "$path"; then
		ok "profiles/$profile/profile.yml keeps portable $expected"
	else
		no "profiles/$profile/profile.yml keeps portable $expected"
	fi
	# This is the intended source-root interpretation for portable profile references.
	if [ -f "$DIR/profiles/$expected" ]; then
		ok "profiles/$profile $expected resolves inside this clone"
	else
		no "profiles/$profile $expected does not resolve inside this clone"
	fi
}

# Wrapper-managed launch-critical seats: must work from arbitrary project cwds.
assert_wrapper_linear_extension pi-project-lead
assert_wrapper_linear_extension pi-conductor

# Project-lead also owns the E2B extension; verify it is wrapper-resolved and clone-local.
project_lead_out="$(run_wrapper_from "$DIR/bin/pi-project-lead" /tmp)"
project_lead_exts="$(printf '%s\n' "$project_lead_out" | extract_extension_args)"
check "pi-project-lead ignores operational FLEET_YOLO in secrets" "ENV:FLEET_YOLO=" \
	"$(printf '%s\n' "$project_lead_out" | grep '^ENV:FLEET_YOLO=' | head -1)"
check "pi-project-lead loads canonical private E2B secret" "ENV:E2B_API_KEY=canonical-key" \
	"$(printf '%s\n' "$project_lead_out" | grep '^ENV:E2B_API_KEY=' | head -1)"
check "pi-project-lead loads canonical private GitHub secret" "ENV:FLEET_GITHUB_TOKEN=canonical-token" \
	"$(printf '%s\n' "$project_lead_out" | grep '^ENV:FLEET_GITHUB_TOKEN=' | head -1)"
check "pi-project-lead loads GitHub OAuth secret" "ENV:GH_TOKEN=github-oauth-token" \
	"$(printf '%s\n' "$project_lead_out" | grep '^ENV:GH_TOKEN=' | head -1)"
check "pi-project-lead loads model provider secret" "ENV:OPENAI_API_KEY=model-key" \
	"$(printf '%s\n' "$project_lead_out" | grep '^ENV:OPENAI_API_KEY=' | head -1)"
check "pi-project-lead loads agent OAuth secret" "ENV:PI_AGENT_AUTH_JSON_B64=oauth-json-b64" \
	"$(printf '%s\n' "$project_lead_out" | grep '^ENV:PI_AGENT_AUTH_JSON_B64=' | head -1)"
check "pi-project-lead loads GitHub App secret" "ENV:FLEET_GITHUB_APP_ID=12345" \
	"$(printf '%s\n' "$project_lead_out" | grep '^ENV:FLEET_GITHUB_APP_ID=' | head -1)"
check "pi-project-lead loads Convex secret" "ENV:FLEET_CONVEX_TOKEN=convex-token" \
	"$(printf '%s\n' "$project_lead_out" | grep '^ENV:FLEET_CONVEX_TOKEN=' | head -1)"

# Legacy sourced grammar is parsed as data and normalized without evaluation.
printf 'export E2B_API_KEY="quoted legacy value"\nGH_TOKEN='"'"'quoted-token'"'"'\nOPENAI_API_KEY=$(touch %s)\n' "$FAKE_HOME/legacy-parser-executed" >"$FAKE_HOME/.pi-fleet/secrets/secrets.env"
chmod 600 "$FAKE_HOME/.pi-fleet/secrets/secrets.env"
legacy_grammar_out="$(run_wrapper_from "$DIR/bin/pi-project-lead" /tmp)"
check "pi-project-lead safely parses export-prefixed legacy secret" "ENV:E2B_API_KEY=quoted legacy value" \
	"$(printf '%s\n' "$legacy_grammar_out" | grep '^ENV:E2B_API_KEY=' | head -1)"
check "pi-project-lead safely parses quoted legacy secret" "ENV:GH_TOKEN=quoted-token" \
	"$(printf '%s\n' "$legacy_grammar_out" | grep '^ENV:GH_TOKEN=' | head -1)"
check "legacy command-substitution-like secret remains literal data" \
	"ENV:OPENAI_API_KEY=\$(touch $FAKE_HOME/legacy-parser-executed)" \
	"$(printf '%s\n' "$legacy_grammar_out" | grep '^ENV:OPENAI_API_KEY=' | head -1)"
[[ ! -e "$FAKE_HOME/legacy-parser-executed" ]] && ok "legacy secret grammar is never evaluated" || no "legacy secret grammar executed command substitution"

# The parser never shell-sources content, rejects unknown keys and insecure metadata, and ignores legacy.
printf 'E2B_API_KEY=$(touch %s)\n' "$FAKE_HOME/parser-executed" >"$FAKE_HOME/.pi-fleet/secrets/secrets.env"
chmod 600 "$FAKE_HOME/.pi-fleet/secrets/secrets.env"
parsed="$(run_wrapper_from "$DIR/bin/pi-project-lead" /tmp)"
[[ ! -e "$FAKE_HOME/parser-executed" ]] && ok "secret values are not evaluated" || no "secret value executed shell syntax"
[[ "$parsed" == *'ENV:E2B_API_KEY=$(touch '* ]] && ok "secret parser preserves literal value" || no "secret parser did not preserve literal value"
printf 'UNKNOWN_KEY=value\n' >"$FAKE_HOME/.pi-fleet/secrets/secrets.env"
chmod 600 "$FAKE_HOME/.pi-fleet/secrets/secrets.env"
if run_wrapper_from "$DIR/bin/pi-project-lead" /tmp >/dev/null 2>&1; then no "unknown secret key is rejected"; else ok "unknown secret key is rejected"; fi
printf 'E2B_API_KEY=value\n' >"$FAKE_HOME/.pi-fleet/secrets/secrets.env"
chmod 644 "$FAKE_HOME/.pi-fleet/secrets/secrets.env"
if run_wrapper_from "$DIR/bin/pi-project-lead" /tmp >/dev/null 2>&1; then no "group/world-readable secret file is rejected"; else ok "group/world-readable secret file is rejected"; fi
rm "$FAKE_HOME/.pi-fleet/secrets/secrets.env"
ln -s "$FAKE_HOME/.pi/fleet/secrets.env" "$FAKE_HOME/.pi-fleet/secrets/secrets.env"
if run_wrapper_from "$DIR/bin/pi-project-lead" /tmp >/dev/null 2>&1; then no "symlink secret file is rejected"; else ok "symlink secret file is rejected"; fi
rm "$FAKE_HOME/.pi-fleet/secrets/secrets.env"
mkdir "$FAKE_HOME/.pi-fleet/secrets/secrets.env"
if run_wrapper_from "$DIR/bin/pi-project-lead" /tmp >/dev/null 2>&1; then no "non-regular secret file is rejected"; else ok "non-regular secret file is rejected"; fi
rmdir "$FAKE_HOME/.pi-fleet/secrets/secrets.env"
legacy_out="$(run_wrapper_from "$DIR/bin/pi-project-lead" /tmp)"
check "legacy ~/.pi/fleet secret is never loaded" "ENV:E2B_API_KEY=" \
	"$(printf '%s\n' "$legacy_out" | grep '^ENV:E2B_API_KEY=' | head -1)"
check "pi-project-lead passes repo-local e2b extension" "$DIR/extensions/e2b" \
	"$(printf '%s\n' "$project_lead_exts" | grep '/extensions/e2b$' | head -1 || true)"

assert_no_profile_extensions project-lead
assert_no_profile_extensions conductor

# Worker/utility profiles that still declare Linear keep the portable repo-relative reference,
# never a developer-machine absolute path.
for profile in ac-verifier docs implementer linear personal-assistant planner reviewer spike-breakdown; do
	assert_profile_repo_relative_linear_extension "$profile"
done

profile_matches="$(grep -R -n '/Users/' "$DIR/profiles" 2>&1)" && profile_grep_status=0 || profile_grep_status=$?
if (( profile_grep_status == 0 )); then
	no "profiles do not contain machine-specific /Users paths"
	printf '%s\n' "$profile_matches"
elif (( profile_grep_status == 1 )); then
	ok "profiles do not contain machine-specific /Users paths"
else
	no "profile machine-path scan completed successfully"
	printf '%s\n' "$profile_matches"
fi

echo "---"
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
