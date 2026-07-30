#!/usr/bin/env bash
# FLT-61 regression guard: Linear issue/project bodies must be markdown content, never bare paths.
#
# Agents previously wrote descriptions as temp file paths (e.g. body = "/tmp/foo.md") instead of
# the file contents. This deterministic structural + smoke check ensures:
#   1. Canonical create/update guidance documents the correct content patterns.
#   2. Guidance does not instruct passing a bare /tmp path as -d/--description.
#   3. A safe fake-linear-cli smoke proves "$(cat file)" / stdin expansion sends content, not path.
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

# ---------------------------------------------------------------------------
# Structural: correct content patterns must be documented in Linear create paths
# (tracked sources only — issue-breakdown is a symlink into agent-skills and is
# not versioned by this repo; linear-management is the fleet-canonical recipe.)
# ---------------------------------------------------------------------------
content_sources=(
	"skills/linear-management/SKILL.md"
	"skills/project-lead/SKILL.md"
	"skills/implementation/SKILL.md"
	"skills/spike-breakdown/SKILL.md"
	"skills/personal-assistant/SKILL.md"
	"agents/linear.md"
	"agents/planner.md"
	"agents/spike-breakdown.md"
	"agents/project-lead.md"
	"agents/implementer.md"
	"profiles/linear/profile.yml"
	"profiles/planner/profile.yml"
	"profiles/spike-breakdown/profile.yml"
	"profiles/project-lead/profile.yml"
	"profiles/implementer/profile.yml"
)

for file in "${content_sources[@]}"; do
	assert_file_contains "$file documents FLT-61 / content-not-path rule" "$file" \
		'FLT-61'
	assert_file_contains "$file documents cat-expansion pattern" "$file" \
		'-d "\$\(cat '
done

# Canonical tracked recipe (linear-management) must show both preferred patterns +
# explicit BAD anti-pattern + checkbox AC in body content.
assert_file_contains "linear-management shows create stdin pattern" \
	"skills/linear-management/SKILL.md" \
	'-d - < /tmp/'
assert_file_contains "linear-management shows update with cat expansion" \
	"skills/linear-management/SKILL.md" \
	'issues update.*--description "\$\(cat'
assert_file_contains "linear-management documents BAD bare-path anti-pattern" \
	"skills/linear-management/SKILL.md" \
	'BAD:[\s\S]*-d /tmp/'
assert_file_contains "linear-management requires checkbox AC in body content" \
	"skills/linear-management/SKILL.md" \
	'Acceptance Criteria[\s\S]*- \[ \]'

# linear-management + agents must require re-read / content verification after write.
assert_file_contains "linear-management requires re-read after write" \
	"skills/linear-management/SKILL.md" \
	're-read'
assert_file_contains "agents/linear requires re-read after write" \
	"agents/linear.md" \
	're-read'

# personal-assistant surfaces the rule when using linear-cli.
assert_file_contains "personal-assistant documents FLT-61 for linear-cli" \
	"skills/personal-assistant/SKILL.md" \
	'FLT-61[\s\S]*-d "\$\(cat'

# ---------------------------------------------------------------------------
# Structural: no guidance may instruct the path-only anti-pattern as correct
# (outside of explicitly labeled BAD/WRONG examples on the same/prev line).
#
# Catches BOTH unquoted and quoted path-only values:
#   -d /tmp/body.md
#   -d "/tmp/body.md"
#   --description '/tmp/x.md'
#   --body "/tmp/comment.md"
# Does NOT match content patterns: -d "$(cat ...)", -d -, -d "markdown text".
# Anti-example suppression is narrow (same line or immediately previous line
# must be BAD/WRONG) so distant "never/do not" prose cannot hide path-only recipes.
# ---------------------------------------------------------------------------
if python3 - "$DIR" <<'PY'; then
import re
import sys
from pathlib import Path

root = Path(sys.argv[1])
targets = [
	"skills/linear-management/SKILL.md",
	"skills/project-lead/SKILL.md",
	"skills/implementation/SKILL.md",
	"skills/spike-breakdown/SKILL.md",
	"skills/personal-assistant/SKILL.md",
	"agents/linear.md",
	"agents/planner.md",
	"agents/spike-breakdown.md",
	"agents/project-lead.md",
	"agents/implementer.md",
	"profiles/linear/profile.yml",
	"profiles/planner/profile.yml",
	"profiles/spike-breakdown/profile.yml",
	"profiles/project-lead/profile.yml",
	"profiles/implementer/profile.yml",
]

# Path-only value after -d / --description / -b / --body:
# unquoted /tmp/..., or quoted "/tmp/..." / '/tmp/...' (entire value is the path).
# Negative lookahead skips: "-", "$(...)", '${...}', and multi-word content.
PATH_VALUE = r"""(?:
	/tmp/[A-Za-z0-9._/+-]+          # unquoted path
	| "/tmp/[A-Za-z0-9._/+-]+"      # double-quoted path only
	| '/tmp/[A-Za-z0-9._/+-]+'      # single-quoted path only
)"""

# Flag + path-only value (works whether or not linear-cli is on the same line).
desc_flag_path = re.compile(
	r"(?:-d|--description)\s+" + PATH_VALUE,
	re.VERBOSE,
)
body_flag_path = re.compile(
	r"(?:-b|--body)\s+" + PATH_VALUE,
	re.VERBOSE,
)

# Explicit anti-example markers only — NOT a broad 12-line "never/do not" window.
bad_marker = re.compile(r"(?i)(?:^|\b)(?:#\s*)?(?:BAD|WRONG)\b|anti-pattern|stores the path string")
correct_marker = re.compile(r"(?i)(?:^|\b)(?:#\s*)?CORRECT\b")
same_line_forbid = re.compile(r"(?i)\b(?:never|do not|don't|not)\b")
fence_re = re.compile(r"^\s*```")

def is_anti_example(lines: list[str], idx: int) -> bool:
	"""True for labeled anti-examples only — narrow enough that path-only recipes cannot hide.

	Rules:
	- Same line has BAD/WRONG → suppress.
	- Same line has never/do not/don't (teaching "never -d /tmp") → suppress.
	- Walk upward within the current section (cap 20 lines):
	  hit # BAD / # WRONG → suppress (covers multi-line BAD blocks in one fence);
	  hit # CORRECT → do not suppress;
	  hit fence open ``` → check only the immediately previous non-empty prose for BAD/WRONG.
	- Distant "never" many lines above does NOT suppress.
	"""
	line = lines[idx]
	if bad_marker.search(line):
		return True
	if same_line_forbid.search(line) and (desc_flag_path.search(line) or body_flag_path.search(line)):
		return True

	j = idx - 1
	steps = 0
	while j >= 0 and steps < 20:
		prev = lines[j]
		stripped = prev.strip()
		if stripped == "":
			j -= 1
			steps += 1
			continue
		if fence_re.match(prev):
			k = j - 1
			while k >= 0 and lines[k].strip() == "":
				k -= 1
			if k >= 0 and bad_marker.search(lines[k]):
				return True
			return False
		if correct_marker.search(prev):
			return False
		if bad_marker.search(prev):
			return True
		j -= 1
		steps += 1
	return False

def find_path_only_violations(text: str, label: str = "") -> list[str]:
	violations: list[str] = []
	lines = text.splitlines()
	for idx, line in enumerate(lines):
		m_desc = desc_flag_path.search(line)
		m_body = body_flag_path.search(line)
		if not m_desc and not m_body:
			continue
		if is_anti_example(lines, idx):
			continue
		kind = "description" if m_desc else "comment body"
		m = m_desc or m_body
		prefix = f"{label}:{idx + 1}: " if label else f"line {idx + 1}: "
		violations.append(f"{prefix}path-only {kind}: {m.group(0)[:120]}")
	return violations

# --- Meta-tests: scanner must catch quoted path-only and not over-suppress ---
meta_fail = []

# (1) Quoted + unquoted path-only MUST be violations when not BAD-labeled.
quoted_cases = [
	'linear-cli issues create "Title" -t TEAM -d "/tmp/body.md"',
	"linear-cli issues update ID --description '/tmp/x.md'",
	'linear-cli comments create --body "/tmp/comment.md" ID',
	'linear-cli issues create "T" -d /tmp/unquoted.md',
	'linear-cli issues update ID --description "/tmp/quoted.md"',
]
for case in quoted_cases:
	v = find_path_only_violations(case + "\n")
	if not v:
		meta_fail.append(f"scanner missed path-only value: {case}")

# (2) Content patterns must NOT be violations.
content_cases = [
	'linear-cli issues create "T" -d "$(cat /tmp/body.md)"',
	'linear-cli issues create "T" -d - < /tmp/body.md',
	'linear-cli issues update ID --description "$(cat /tmp/body.md)"',
	'linear-cli comments create --body "$(cat /tmp/c.md)" ID',
	'linear-cli issues create "T" -d "# real markdown body with - [ ] ac"',
]
for case in content_cases:
	v = find_path_only_violations(case + "\n")
	if v:
		meta_fail.append(f"scanner false-positive on content: {case} -> {v}")

# (3) Multi-line BAD section in one fence: both path-only lines suppressed after # BAD.
bad_block = """```bash
# CORRECT
linear-cli issues create T -d "$(cat /tmp/body.md)"
# BAD: stores the path string as the description
linear-cli issues create T -d /tmp/body.md
linear-cli issues update ID --description "/tmp/body.md"
```
"""
if find_path_only_violations(bad_block):
	meta_fail.append(
		f"scanner failed to suppress multi-line BAD block: {find_path_only_violations(bad_block)}"
	)

wrong_ok = "# WRONG — path as body\nlinear-cli issues update ID -d \"/tmp/body.md\"\n"
if find_path_only_violations(wrong_ok):
	meta_fail.append("scanner failed to suppress WRONG-labeled quoted anti-example")

# Distant "never" 12 lines above must NOT hide a real path-only recipe.
distant = (
	"Never write path-only bodies.\n"
	+ "\n" * 10
	+ 'linear-cli issues create "T" -d "/tmp/hidden.md"\n'
)
if not find_path_only_violations(distant):
	meta_fail.append("scanner over-suppressed path-only recipe near distant 'never'")

# Same-line "never `-d /tmp`" teaching prose is allowed (not a positive recipe).
inline_never = 'Use content; never `-d /tmp/body.md` as the description.\n'
if find_path_only_violations(inline_never):
	meta_fail.append("scanner failed to suppress same-line never teaching")

inline_bad = "# BAD: never do this: linear-cli issues create T -d /tmp/body.md\n"
if find_path_only_violations(inline_bad):
	meta_fail.append("scanner failed to suppress same-line BAD marker")

if meta_fail:
	print("SCANNER_META_FAIL")
	for m in meta_fail:
		print(m)
	sys.exit(2)

# --- Scan tracked guidance sources ---
violations = []
for rel in targets:
	path = root / rel
	violations.extend(find_path_only_violations(path.read_text(encoding="utf-8"), label=rel))

if violations:
	print("UNEXPECTED_PATH_ONLY_INSTRUCTIONS")
	for v in violations:
		print(v)
	sys.exit(1)
sys.exit(0)
PY
	ok "scanner catches quoted+unquoted path-only -d/--description/--body (meta)"
	ok "scanner does not over-suppress via distant never/do-not (meta)"
	ok "no path-only /tmp value instructed as a correct -d/--description/--body recipe"
else
	rc=$?
	if [ "$rc" -eq 2 ]; then
		no "scanner catches quoted+unquoted path-only -d/--description/--body (meta)"
		no "scanner does not over-suppress via distant never/do-not (meta)"
	else
		ok "scanner catches quoted+unquoted path-only -d/--description/--body (meta)"
		ok "scanner does not over-suppress via distant never/do-not (meta)"
		no "no path-only /tmp value instructed as a correct -d/--description/--body recipe"
	fi
fi

# ---------------------------------------------------------------------------
# Smoke: prove content patterns send markdown, not the path string
# ---------------------------------------------------------------------------
SCRATCH="$(mktemp -d /tmp/pi-fleet-flt61.XXXXXX)"
cleanup() { rm -rf "$SCRATCH"; }
trap cleanup EXIT

FAKE_BIN="$SCRATCH/bin"
mkdir -p "$FAKE_BIN"
CAPTURE="$SCRATCH/captured-description.txt"
BODY_FILE="$SCRATCH/issue-body.md"
cat > "$BODY_FILE" <<'MD'
As a fleet operator, I want Linear bodies to be real markdown, so AC is verifiable.

### Acceptance criteria
- [ ] description contains this full markdown, not a filesystem path
- [ ] create via cat-expansion lands content
- [ ] create via stdin lands content
MD

# Fake linear-cli: capture the description argument that would be sent to Linear.
cat > "$FAKE_BIN/linear-cli" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
out="${PI_FLEET_FLT61_CAPTURE:?}"
mode=none
desc=""
args=("$@")
i=0
while (( i < ${#args[@]} )); do
	a="${args[$i]}"
	case "$a" in
		-d|--description)
			i=$((i + 1))
			val="${args[$i]:-}"
			if [ "$val" = "-" ]; then
				# read stdin as description (create pattern)
				desc="$(cat)"
				mode=stdin
			else
				desc="$val"
				mode=flag
			fi
			;;
	esac
	i=$((i + 1))
done
printf '%s\n' "$mode" > "${out}.mode"
printf '%s' "$desc" > "$out"
# Emit a minimal JSON-ish success so callers don't choke if they parse.
echo '{"ok":true,"identifier":"FLT-SMOKE"}'
EOF
chmod +x "$FAKE_BIN/linear-cli"
export PATH="$FAKE_BIN:$PATH"
export PI_FLEET_FLT61_CAPTURE="$CAPTURE"

# Pattern A: cat expansion (create)
rm -f "$CAPTURE" "$CAPTURE.mode"
linear-cli issues create "Smoke title" -t pi-fleet -d "$(cat "$BODY_FILE")" >/dev/null
got="$(cat "$CAPTURE")"
if [ "$got" = "$(cat "$BODY_FILE")" ] && ! [[ "$got" == /tmp/* ]]; then
	ok "smoke create -d \"\$(cat file)\" sends file contents"
else
	no "smoke create -d \"\$(cat file)\" sends file contents"
	echo "  got: ${got:0:200}"
fi
if grep -q 'Acceptance criteria' "$CAPTURE" && grep -q '\- \[ \]' "$CAPTURE"; then
	ok "smoke create body includes checkbox AC content"
else
	no "smoke create body includes checkbox AC content"
fi

# Pattern B: stdin via -d -
rm -f "$CAPTURE" "$CAPTURE.mode"
linear-cli issues create "Smoke title" -t pi-fleet -d - < "$BODY_FILE" >/dev/null
got="$(cat "$CAPTURE")"
mode="$(cat "$CAPTURE.mode")"
if [ "$mode" = "stdin" ] && [ "$got" = "$(cat "$BODY_FILE")" ]; then
	ok "smoke create -d - < file sends file contents via stdin"
else
	no "smoke create -d - < file sends file contents via stdin"
	echo "  mode=$mode got=${got:0:200}"
fi

# Pattern C: update with cat expansion
rm -f "$CAPTURE" "$CAPTURE.mode"
linear-cli issues update FLT-SMOKE --description "$(cat "$BODY_FILE")" >/dev/null
got="$(cat "$CAPTURE")"
if [ "$got" = "$(cat "$BODY_FILE")" ] && ! [[ "$got" == /tmp/* ]]; then
	ok "smoke update --description \"\$(cat file)\" sends file contents"
else
	no "smoke update --description \"\$(cat file)\" sends file contents"
	echo "  got: ${got:0:200}"
fi

# Anti-pattern control: bare path MUST be detectable as wrong (path == body)
rm -f "$CAPTURE" "$CAPTURE.mode"
linear-cli issues create "Smoke title" -t pi-fleet -d "$BODY_FILE" >/dev/null
got="$(cat "$CAPTURE")"
if [ "$got" = "$BODY_FILE" ]; then
	ok "smoke control: bare -d path would store the path string (anti-pattern confirmed)"
else
	no "smoke control: bare -d path would store the path string (anti-pattern confirmed)"
	echo "  got: ${got:0:200}"
fi

# Eval README must document this guard.
assert_file_contains "evals/README.md documents FLT-61 structural guard" \
	"evals/README.md" \
	'linear-body-content-structural-test\.sh'

echo "---"
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
