import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function config() {
  const path = new URL("../permission-system/project-lead.json", import.meta.url);
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    assert.fail(`invalid project-lead config: ${error instanceof Error ? error.message : String(error)}`);
  }
}

test("Pi project-lead config defaults Bash to deny while exposing no mutation tools", async () => {
  const value = await config();
  assert.equal(value.yoloMode, false);
  assert.equal(value.permission.write, "deny");
  assert.equal(value.permission.edit, "deny");
  assert.equal(value.permission.bash["*"], "deny");
});

test("Pi project-lead config allows coordination and main integration", async () => {
  const { permission } = await config();
  for (const pattern of [
    "cmux *",
    "linear-cli *",
    "check-model-usage *",
    "gh pr view *",
    "gh pr merge *",
    "gh pr comment *",
    "git status *",
    "git checkout main",
    "git switch main",
    "git fetch *",
    "git pull --ff-only *",
    "git merge *",
    "git push *",
    "git worktree add *",
    "git worktree remove *",
    "cat *",
    "jq *",
    "uptime",
    "fleet-note *",
    "fleet-mail *",
  ]) assert.equal(permission.bash[pattern], "allow", pattern);
  for (const subcommand of ["status", "log", "diff", "show", "rev-parse"])
    for (const suffix of ["", " *"])
      assert.equal(
        permission.bash[`git -C * ${subcommand}${suffix}`],
        "allow",
        `git -C * ${subcommand}${suffix}`,
      );
});

test("Pi project-lead config denies product-implementation shell", async () => {
  const { permission } = await config();
  for (const pattern of [
    "git clone *",
    "git commit *",
    "gh pr review *",
    "npm *",
    "pnpm *",
    "yarn *",
    "bun *",
    "node *",
    "python *",
    "python3 *",
    "make *",
    "cargo *",
    "./*",
    "bash *",
    "sh *",
    "tee *",
  ]) assert.equal(permission.bash[pattern], "deny", pattern);
});
