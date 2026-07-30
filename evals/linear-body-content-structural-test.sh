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
# Structural: no guidance may instruct the bare-path anti-pattern as correct
# (outside of explicitly labeled BAD/WRONG examples)
# ---------------------------------------------------------------------------
# Scan for instructional lines that look like correct recipes using bare -d /tmp
# without being inside a BAD/WRONG context. We use a Python scan so we can strip
# BAD/WRONG fenced examples first.
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
# Match a linear-cli create/update with -d or --description whose value is a bare /tmp path
# (not "$(cat ...)", not "-", not quoted content).
bare_path = re.compile(
	r"""linear-cli\s+(?:issues|i|projects|p|proj)\s+(?:create|update)\b[^\n]*"""
	r"""(?:-d|--description)\s+(?!-)(?!\"\$\()(?!'\$\()(?!\"\$\{)(/tmp/[^\s\"']+)""",
	re.IGNORECASE,
)
bare_body = re.compile(
	r"""linear-cli\s+(?:comments|c)\s+create\b[^\n]*"""
	r"""(?:-b|--body)\s+(?!-)(?!\"\$\()(?!'\$\()(/tmp/[^\s\"']+)""",
	re.IGNORECASE,
)
# Lines that mark anti-examples (prose or comments inside fences).
anti = re.compile(r"(?i)\b(bad|wrong|never|do not|don't|anti-pattern|stores the path)\b")

violations = []
for rel in targets:
	path = root / rel
	lines = path.read_text(encoding="utf-8").splitlines()
	for idx, line in enumerate(lines):
		m = bare_path.search(line) or bare_body.search(line)
		if not m:
			continue
		# Look back up to 12 lines for anti-example framing (covers "Wrong…" + blank + fence + # BAD).
		window = "\n".join(lines[max(0, idx - 12) : idx + 1])
		if anti.search(window):
			continue
		kind = "description" if bare_path.search(line) else "comment body"
		violations.append(f"{rel}:{idx + 1}: bare path as {kind}: {m.group(0)[:120]}")

if violations:
	print("UNEXPECTED_BARE_PATH_INSTRUCTIONS")
	for v in violations:
		print(v)
	sys.exit(1)
sys.exit(0)
PY
	ok "no bare /tmp path instructed as a correct -d/--description recipe"
else
	no "no bare /tmp path instructed as a correct -d/--description recipe"
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
