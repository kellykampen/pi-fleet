import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import test from "node:test";

const root = new URL("..", import.meta.url).pathname;
const hook = `${root}bin/claude-bash-policy-hook`;

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    assert.fail(`invalid JSON at ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function invoke(seat, command, overrides = {}) {
  return spawnSync(hook, [seat], {
    encoding: "utf8",
    input: JSON.stringify({ tool_name: "Bash", tool_input: { command }, ...overrides }),
  });
}

test("Claude hook allows seat-specific atomic commands", () => {
  assert.equal(invoke("conductor", "cmux workspace list --json").status, 0);
  assert.equal(invoke("lead", "git checkout develop").status, 0);
  assert.equal(invoke("lead", "gh pr merge 42 --merge").status, 0);
});

test("Claude hook blocks with exit 2 when a command is outside policy", () => {
  for (const [seat, command] of [
    ["conductor", "git merge feature"],
    ["lead", "npm ci"],
    ["lead", "cmux workspace list && node build.js"],
    ["lead", "cat README.md > bin/foo.sh"],
  ]) {
    const result = invoke(seat, command);
    assert.equal(result.status, 2, `${seat}: ${command}\n${result.stderr}`);
    assert.match(result.stderr, /blocked by .* policy/i);
  }
});

test("Claude hook fails closed on malformed hook input and unknown seats", () => {
  let result = spawnSync(hook, ["lead"], { encoding: "utf8", input: "not-json" });
  assert.equal(result.status, 2);
  result = invoke("implementer", "cmux workspace list");
  assert.equal(result.status, 2);
  result = spawnSync(hook, ["lead"], {
    encoding: "utf8",
    input: JSON.stringify({ tool_name: "Bash", tool_input: {} }),
  });
  assert.equal(result.status, 2);
});

test("Claude policies are separate, real dontAsk settings with authoritative hooks", async () => {
  const conductor = await readJson(`${root}claude-settings/conductor.json`);
  const lead = await readJson(`${root}claude-settings/project-lead.json`);

  assert.equal(conductor.permissions.defaultMode, "dontAsk");
  assert.equal(lead.permissions.defaultMode, "dontAsk");
  assert.notDeepEqual(conductor.permissions.allow, lead.permissions.allow);
  assert.ok(lead.permissions.allow.includes("Bash(gh pr merge:*)"));
  assert.ok(!conductor.permissions.allow.includes("Bash(gh pr merge:*)"));
  assert.equal(conductor.hooks.PreToolUse[0].matcher, "Bash");
  assert.equal(lead.hooks.PreToolUse[0].matcher, "Bash");
  assert.match(conductor.hooks.PreToolUse[0].hooks[0].command, /claude-bash-policy-hook" conductor$/);
  assert.match(lead.hooks.PreToolUse[0].hooks[0].command, /claude-bash-policy-hook" lead$/);
});
