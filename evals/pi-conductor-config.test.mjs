import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function config() {
  const path = new URL("../permission-system/conductor.json", import.meta.url);
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    assert.fail(`invalid conductor config: ${error instanceof Error ? error.message : String(error)}`);
  }
}

test("Pi conductor config defaults Bash to deny while exposing no mutation tools", async () => {
  const value = await config();
  assert.equal(value.yoloMode, false);
  assert.equal(value.permission.write, "deny");
  assert.equal(value.permission.edit, "deny");
  assert.equal(value.permission.bash["*"], "deny");
});

test("Pi conductor config allows orchestration and explicitly denies implementation", async () => {
  const { permission } = await config();
  for (const pattern of [
    "cmux *",
    "linear-cli *",
    "check-model-usage *",
    "gh pr view *",
    "git status *",
    "cat *",
    "jq *",
    "uptime",
    "fleet-note *",
  ]) assert.equal(permission.bash[pattern], "allow", pattern);
  for (const subcommand of ["status", "log", "diff", "show", "rev-parse"])
    for (const suffix of ["", " *"])
      assert.equal(
        permission.bash[`git -C * ${subcommand}${suffix}`],
        "allow",
        `git -C * ${subcommand}${suffix}`,
      );
  for (const pattern of [
    "git -C * branch",
    "git -C * branch --list",
    "git -C * branch --list *",
  ])
    assert.equal(permission.bash[pattern], "allow", pattern);
  for (const pattern of [
    "git clone *",
    "git checkout *",
    "git merge *",
    "git push *",
    "npm *",
    "pnpm *",
    "node *",
    "python *",
    "make *",
    "cargo *",
    "./*",
    "bash *",
    "sh *",
    "tee *",
  ]) assert.equal(permission.bash[pattern], "deny", pattern);
});
