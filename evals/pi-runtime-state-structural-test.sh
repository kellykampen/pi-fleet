#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SCHEMA="$ROOT/docs/runtime-state.schema.v1.json"
[[ -f "$ROOT/docs/runtime-state.md" && -f "$SCHEMA" ]]
python3 - "$SCHEMA" <<'PY'
import copy, json, sys
schema = json.load(open(sys.argv[1]))
for key in ("type", "properties", "required", "$defs", "examples"):
    assert key in schema, f"schema missing {key}"

def validate(value, rule, root=schema):
    if "$ref" in rule:
        target = root
        for part in rule["$ref"].removeprefix("#/").split("/"): target = target[part]
        return validate(value, target, root)
    if "const" in rule: assert value == rule["const"]
    if "enum" in rule: assert value in rule["enum"]
    kind = rule.get("type")
    if kind == "object":
        assert isinstance(value, dict) and not isinstance(value, bool)
        for key in rule.get("required", []): assert key in value
        if rule.get("additionalProperties") is False: assert set(value) <= set(rule.get("properties", {}))
        for key, child in rule.get("properties", {}).items():
            if key in value: validate(value[key], child, root)
    elif kind == "array":
        assert isinstance(value, list)
        assert len(value) >= rule.get("minItems", 0)
        if rule.get("uniqueItems"): assert len({json.dumps(v, sort_keys=True) for v in value}) == len(value)
        if "items" in rule:
            for item in value: validate(item, rule["items"], root)
    elif kind == "string": assert isinstance(value, str) and len(value) >= rule.get("minLength", 0)
    elif kind == "integer":
        assert isinstance(value, int) and not isinstance(value, bool)
        assert value >= rule.get("minimum", value) and value <= rule.get("maximum", value)

example = schema["examples"][0]
validate(example, schema)
for mutate in (
    lambda value: value.pop("migration"),
    lambda value: value["jobRetention"].update(deleteRequiresFlag="--unsafe"),
    lambda value: value["schedulerCleanup"].update(preserveExternalTasks=False),
):
    invalid = copy.deepcopy(example); mutate(invalid)
    try: validate(invalid, schema)
    except AssertionError: pass
    else: raise AssertionError("representative invalid runtime-state fixture passed schema")
PY

for profile_file in "$ROOT"/profiles/*/profile.yml; do
	grep -Eq '^[[:space:]]+-[[:space:]]+\.\./skills/fleet-state[[:space:]]*$' "$profile_file"
done
for agent_file in "$ROOT"/agents/*.md; do
	grep -Eq '(^|[^[:alnum:]-])fleet-state([^[:alnum:]-]|$)' "$agent_file"
done
for phrase in 'ad-hoc top-level' 'secret' 'copied durable policy' 'exactly one' 'report-only' 'handoffs/conductor' 'handoffs/projects/<stable-id>' 'archive'; do
	grep -qi "$phrase" "$ROOT/skills/fleet-state/SKILL.md"
done

# Scan every current policy/guidance source. Only explicit migration/history files may name legacy roots.
matches="$(python3 - "$ROOT" <<'PY'
import re, sys
from pathlib import Path
root = Path(sys.argv[1])
excluded = {"pi-fleet-state-migrate", "runtime-state.md", "pi-runtime-state-smoke-test.sh"}
pattern = re.compile(r"~?/\.pi/fleet|\$HOME/\.pi/fleet|Library/Logs/pi-fleet")
found = False
for source in [root / "bin", root / "extensions", root / "README.md", root / "docs", root / "agents", root / "skills", root / "profiles"]:
    files = [source] if source.is_file() else source.rglob("*")
    for path in files:
        if not path.is_file() or path.name in excluded: continue
        if any(part in {".git", ".pi-subagents", "node_modules"} for part in path.parts): continue
        if path.suffix not in {"", ".ts", ".js", ".mjs", ".json", ".md", ".sh", ".yml", ".yaml"}: continue
        try: lines = path.read_text(errors="strict").splitlines()
        except (OSError, UnicodeError) as error:
            print(f"{path}: {error}", file=sys.stderr); raise SystemExit(2)
        for number, line in enumerate(lines, 1):
            if pattern.search(line): print(f"{path}:{number}:{line}"); found = True
raise SystemExit(0 if found else 1)
PY
)" && status=0 || status=$?
if (( status == 0 )); then printf '%s\n' "$matches" >&2; echo 'deprecated current runtime path found' >&2; exit 1; fi
if (( status > 1 )); then printf '%s\n' "$matches" >&2; exit "$status"; fi

grep -q 'state/scheduler/backups' "$ROOT/bin/lib/scheduler-status.sh"
grep -q 'logs/personal' "$ROOT/bin/pi-personal-schedule-sync"
grep -q 'pi-fleet-state-migrate' "$ROOT/bin/pi-fleet-bootstrap"
echo 'ok - canonical runtime-state schema, structure, and fleet-state wiring'
