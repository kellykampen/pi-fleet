#!/usr/bin/env bash
# FLT-65 structural guard: conductor is routing-only — no product PR-diff review,
# no gh api patch content, no in-repo ticket investigation. Lead retains gate tools.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

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
assert_file_contains() {
	local desc="$1" file="$2" pattern="$3"
	if python3 - "$DIR/$file" "$pattern" <<'PY'; then
import re
import sys
path, pattern = sys.argv[1], sys.argv[2]
text = open(path, encoding="utf-8").read()
sys.exit(0 if re.search(pattern, text, re.MULTILINE | re.DOTALL) else 1)
PY
		ok "$desc"
	else
		no "$desc"
		echo "  missing pattern: $pattern"
		echo "  in: $file"
	fi
}
assert_file_lacks() {
	local desc="$1" file="$2" pattern="$3"
	if python3 - "$DIR/$file" "$pattern" <<'PY'; then
import re
import sys
path, pattern = sys.argv[1], sys.argv[2]
text = open(path, encoding="utf-8").read()
sys.exit(0 if not re.search(pattern, text, re.MULTILINE | re.DOTALL) else 1)
PY
		ok "$desc"
	else
		no "$desc"
		echo "  unexpectedly found pattern: $pattern"
		echo "  in: $file"
	fi
}

WRAPPER="$DIR/bin/pi-conductor"
tools_line="$(grep -E -- '--tools ' "$WRAPPER" | tail -1)"

if printf '%s\n' "$tools_line" | grep -Eq -- '--tools bash,linear_get_issue,linear_list,linear_comment,linear_update'; then
	ok "pi-conductor --tools is routing-only (bash + linear only)"
else
	no "pi-conductor --tools is routing-only (bash + linear only)"
	echo "  tools line: $tools_line"
fi
if printf '%s\n' "$tools_line" | grep -Eq 'write|edit|read|grep|find|,ls,|^.*ls,'; then
	# Explicit product-investigation tokens must not appear.
	if printf '%s\n' "$tools_line" | grep -Eq 'write|edit|\bread\b|\bgrep\b|\bfind\b|\bls\b'; then
		no "pi-conductor tools line still names product investigation tools"
		echo "  tools line: $tools_line"
	else
		ok "pi-conductor tools line omits product investigation tools"
	fi
else
	ok "pi-conductor tools line omits product investigation tools"
fi

assert_file_contains "wrapper loads conductor-policy extension" \
	"bin/pi-conductor" \
	'extensions/conductor-policy\.ts'
assert_file_contains "permission config denies git diff" \
	"permission-system/conductor.json" \
	'"git diff \*":\s*"deny"'
assert_file_contains "permission config denies git show" \
	"permission-system/conductor.json" \
	'"git show \*":\s*"deny"'
assert_file_contains "permission config denies gh pr view" \
	"permission-system/conductor.json" \
	'"gh pr view \*":\s*"deny"'
assert_file_contains "permission config denies gh api" \
	"permission-system/conductor.json" \
	'"gh api \*":\s*"deny"'
assert_file_contains "permission config denies cat content reader" \
	"permission-system/conductor.json" \
	'"cat \*":\s*"deny"'
assert_file_contains "permission config allows gh pr list metadata" \
	"permission-system/conductor.json" \
	'"gh pr list \*":\s*"allow"'
assert_file_contains "permission config allows gh pr checks metadata" \
	"permission-system/conductor.json" \
	'"gh pr checks \*":\s*"allow"'
assert_file_contains "permission config allows cmux routing" \
	"permission-system/conductor.json" \
	'"cmux \*":\s*"allow"'
assert_file_contains "permission config allows linear-cli routing" \
	"permission-system/conductor.json" \
	'"linear-cli \*":\s*"allow"'
assert_file_contains "permission config allows fleet-mail lead rollups" \
	"permission-system/conductor.json" \
	'"fleet-mail \*":\s*"allow"'

assert_file_contains "claude conductor denies Read" \
	"claude-settings/conductor.json" \
	'"Read"'
assert_file_contains "claude conductor denies gh pr view" \
	"claude-settings/conductor.json" \
	'Bash\(gh pr view:\*\)'
assert_file_contains "claude conductor denies gh api" \
	"claude-settings/conductor.json" \
	'Bash\(gh api:\*\)'
assert_file_contains "claude conductor allows gh pr list" \
	"claude-settings/conductor.json" \
	'Bash\(gh pr list:\*\)'
assert_file_lacks "claude conductor does not allow product Read tool" \
	"claude-settings/conductor.json" \
	'"allow":\s*\[[^\]]*"Read"'

# Skill / agent / profile phrases (FLT-65).
for file in \
	"skills/conductor/SKILL.md" \
	"agents/conductor.md" \
	"profiles/conductor/profile.yml"; do
	assert_file_contains "$file names FLT-65 routing-only boundary" \
		"$file" \
		'FLT-65|Routing-only boundary \(FLT-65\)|routing-only boundary \(FLT-65\)'
	assert_file_contains "$file forbids product PR diffs" \
		"$file" \
		'NEVER read product PR diffs|never read product PR diffs|Never.*product PR diffs|NEVER.*product PR diffs'
	assert_file_contains "$file forbids gh api review path" \
		"$file" \
		'NEVER use `?gh api`|NEVER use gh api|never use `?gh api`|Use `?gh api`|gh api.*product review|`gh api`.*product'
	assert_file_contains "$file forbids in-repo ticket investigation" \
		"$file" \
		'NEVER investigate tickets in-repo|never investigate tickets in-repo|Never investigate tickets in-repo'
done

assert_file_contains "skill allows portfolio metadata gh pr list/checks" \
	"skills/conductor/SKILL.md" \
	'gh pr list.*gh pr checks|`gh pr list`.*`gh pr checks`'
assert_file_contains "docs/permissions documents FLT-65 conductor denies" \
	"docs/permissions.md" \
	'FLT-65 product-review'
assert_file_contains "README documents pi-conductor routing-only tools" \
	"README.md" \
	'no read/grep/find/ls/write/edit|allowlisted \*\*bash\*\* \+ linear \*\(no read'

# Policy unit: conductor denies product review; lead still allows view/diff for gates.
POLICY_JS="$DIR/evals/.tmp-conductor-restrict-policy-check.mjs"
cat >"$POLICY_JS" <<'JS'
import assert from "node:assert/strict";
import { evaluateCommand } from "../bin/lib/conductor-command-policy.mjs";

const allow = (command, seat) =>
	assert.equal(evaluateCommand(command, { seat, cwd: "/repo" }).allowed, true, `${seat}: ${command}`);
const deny = (command, seat) =>
	assert.equal(evaluateCommand(command, { seat, cwd: "/repo" }).allowed, false, `${seat}: ${command}`);

for (const command of [
	"cmux workspace list --json",
	"gh pr list --state open",
	"gh pr checks 42",
	"git status --short",
	"linear-cli issue get FLT-65",
	"fleet-mail inbox --mailbox conductor --unread",
]) allow(command, "conductor");

for (const command of [
	"gh pr view 42",
	"gh api repos/o/r/pulls/42",
	"git diff HEAD",
	"git show HEAD:file.ts",
	"cat src/app.ts",
	"rg TODO src",
	"find . -name '*.ts'",
]) deny(command, "conductor");

// Lead still holds gates: may view PRs and read content (but not implement).
allow("gh pr view 42", "lead");
allow("git diff HEAD", "lead");
allow("cat README.md", "lead");
deny("gh api repos/o/r/pulls/42", "lead");
deny("pnpm test", "lead");

console.log("conductor-restrict-policy-unit-ok");
JS
if node "$POLICY_JS" >/dev/null; then
	ok "command policy denies conductor product review and keeps lead gates"
else
	no "command policy denies conductor product review and keeps lead gates"
	node "$POLICY_JS" || true
fi
rm -f "$POLICY_JS"

# Preserve FLT-57 topology + lead delegate-only alignment.
assert_file_contains "conductor skill still encodes FLT-57 topology" \
	"skills/conductor/SKILL.md" \
	'Communication topology \(FLT-57\)'
assert_file_contains "project-lead skill still forbids self-implementation" \
	"skills/project-lead/SKILL.md" \
	'do not implement, review, AC-verify, docs-pass, or "just do a light'
assert_file_contains "project-lead permission still allows gh pr view for gates" \
	"permission-system/project-lead.json" \
	'"gh pr view \*":\s*"allow"'

echo "---"
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
