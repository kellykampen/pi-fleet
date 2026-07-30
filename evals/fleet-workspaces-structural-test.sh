#!/usr/bin/env bash
# Structural + unit coverage for FLT-69 workspaces.json registry.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

[[ -f "$ROOT/bin/lib/fleet-workspaces.cjs" ]]
[[ -x "$ROOT/bin/fleet-workspaces" ]]
[[ -f "$ROOT/bin/lib/fleet-workspaces.sh" ]]
[[ -f "$ROOT/docs/workspaces.md" ]]
[[ -f "$ROOT/docs/workspaces.sample.json" ]]
[[ -f "$ROOT/docs/workspaces.schema.v1.json" ]]

# Sample matches schema shape (version + required defaults).
python3 - "$ROOT/docs/workspaces.sample.json" "$ROOT/docs/workspaces.schema.v1.json" <<'PY'
import json, sys
sample = json.load(open(sys.argv[1]))
schema = json.load(open(sys.argv[2]))
assert sample["version"] == schema["properties"]["version"]["const"] == 1
assert "fantastic-dev" in sample["workspaces"]
assert "pi-fleet" in sample["workspaces"]
ftd = sample["workspaces"]["fantastic-dev"]
flt = sample["workspaces"]["pi-fleet"]
assert ftd["linear"]["teamKey"] == "FTD"
assert ftd["leadMailbox"] == "ftd-project-lead"
assert "fantastic-dev" in ftd["cwdMatchers"]
assert flt["linear"]["teamKey"] == "FLT"
assert flt["leadMailbox"] == "pi-fleet-project-lead"
assert schema["examples"][0]["workspaces"]["pi-fleet"]["leadMailbox"] == "pi-fleet-project-lead"
PY

# Launch wiring
grep -q 'fleet-workspaces.sh' "$ROOT/bin/lib/pi-project-lead-runtime.sh"
grep -q 'fleet_workspaces_resolve_and_export' "$ROOT/bin/lib/pi-project-lead-runtime.sh"
grep -q 'fleet-workspaces.sh' "$ROOT/bin/lib/pi-conductor-runtime.sh"
grep -q 'FLEET_WORKSPACES_PATH\|fleet_workspaces_ensure_file' "$ROOT/bin/lib/pi-conductor-runtime.sh"

# Command policy hard-enforces allowed roots + allows fleet-workspaces CLI
grep -q 'FLEET_ALLOWED_REPO_ROOTS' "$ROOT/bin/lib/conductor-command-policy.mjs"
grep -q 'fleet-workspaces' "$ROOT/bin/lib/conductor-command-policy.mjs"
grep -q 'allowUnderRepoRoots' "$ROOT/bin/lib/conductor-command-policy.mjs"

# Skill / profile / agent docs mention load-after-cmux-list and hard vs instruction
grep -q 'workspaces.json' "$ROOT/skills/conductor/SKILL.md"
grep -q 'fleet_workspaces_map_cmux_list\|fleet-workspaces resolve' "$ROOT/skills/conductor/SKILL.md"
grep -q 'FLEET_ALLOWED_REPO_ROOTS' "$ROOT/skills/project-lead/SKILL.md"
grep -q 'Hard-enforced' "$ROOT/skills/project-lead/SKILL.md"
grep -q 'workspaces.json' "$ROOT/agents/conductor.md"
grep -q 'FLEET_ALLOWED_REPO_ROOTS' "$ROOT/agents/project-lead.md"
grep -q 'workspaces.json' "$ROOT/profiles/conductor/profile.yml"
grep -q 'FLEET_ALLOWED_REPO_ROOTS' "$ROOT/profiles/project-lead/profile.yml"
grep -q 'workspaces.json' "$ROOT/skills/fleet-state/SKILL.md"
grep -q 'workspaces.json' "$ROOT/docs/runtime-state.md"
grep -q 'workspaces.json' "$ROOT/docs/runtime-state.schema.v1.json"

# Unit tests
node --test "$ROOT/evals/fleet-workspaces.test.mjs"

# Policy: git -C outside roots denied for lead when FLEET_ALLOWED_REPO_ROOTS set
node --input-type=module <<NODE
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
const mod = await import(pathToFileURL("$ROOT/bin/lib/conductor-command-policy.mjs").href);
const { evaluateCommand } = mod;

process.env.FLEET_ALLOWED_REPO_ROOTS = "/Users/x/code/pi-fleet";
const ok = evaluateCommand("git -C /Users/x/code/pi-fleet status", {
  seat: "lead",
  cwd: "/Users/x/code/pi-fleet",
});
assert.equal(ok.allowed, true, JSON.stringify(ok));

const bad = evaluateCommand("git -C /Users/x/code/other status", {
  seat: "lead",
  cwd: "/Users/x/code/pi-fleet",
});
assert.equal(bad.allowed, false, "cross-project git -C must be denied");
assert.match(bad.reason, /FLEET_ALLOWED_REPO_ROOTS/);

const fleetWs = evaluateCommand("fleet-workspaces list", { seat: "conductor", cwd: "/tmp" });
assert.equal(fleetWs.allowed, true);

delete process.env.FLEET_ALLOWED_REPO_ROOTS;
console.log("policy allowedRepoRoots checks ok");
NODE

echo "fleet-workspaces-structural-test: OK"
