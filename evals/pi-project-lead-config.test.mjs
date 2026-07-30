import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import test from "node:test";
import { evaluateCommand } from "../bin/lib/conductor-command-policy.mjs";

test("permission-system directory is removed (FLT-67)", async () => {
  await assert.rejects(
    () => access(new URL("../permission-system/project-lead.json", import.meta.url), constants.F_OK),
    /ENOENT/,
  );
  await assert.rejects(
    () => access(new URL("../permission-system", import.meta.url), constants.F_OK),
    /ENOENT/,
  );
});

test("project-lead wrapper does not load pi-permission-system", async () => {
  const wrapper = await readFile(new URL("../bin/pi-project-lead", import.meta.url), "utf8");
  // Comments may mention the removed package; operational wiring must be absent.
  assert.equal(/export\s+PI_PERMISSION_SYSTEM_PATH|PI_PERMISSION_SYSTEM_PATH\s*=/.test(wrapper), false);
  assert.equal(/--extension[^\n]*@gotgenes\/pi-permission-system|npm\/node_modules\/@gotgenes\/pi-permission-system/.test(wrapper), false);
  assert.match(wrapper, /--approve/);
  assert.match(wrapper, /project-lead-policy\.ts/);
  const toolsLine = wrapper.split("\n").find((line) => /--tools\s+read,grep,find,ls,bash,/.test(line)) ?? "";
  assert.match(toolsLine, /--tools read,grep,find,ls,bash,/);
  assert.doesNotMatch(toolsLine, /\b(write|edit)\b/);
});

test("project-lead-policy.ts evaluates seat lead", async () => {
  const policy = await readFile(new URL("../extensions/project-lead-policy.ts", import.meta.url), "utf8");
  assert.match(policy, /seat:\s*"lead"/);
  assert.doesNotMatch(policy, /pi-permission-system supplies/);
});

test("seat lead command policy allows coordination and denies implementation", () => {
  const allow = (command) =>
    assert.equal(evaluateCommand(command, { seat: "lead", cwd: "/repo" }).allowed, true, command);
  const deny = (command) =>
    assert.equal(evaluateCommand(command, { seat: "lead", cwd: "/repo" }).allowed, false, command);
  for (const command of [
    "cmux workspace list",
    "linear-cli issue get FLT-1",
    "gh pr view 1",
    "gh pr merge 1 --merge",
    "git status --short",
    "git fetch origin",
    "git pull --ff-only origin main",
    "git checkout main",
    "git push origin main",
    "uptime",
    "fleet-note append coordination/status.md ok",
    "fleet-mail inbox --mailbox project-lead --unread",
    "fleet-mail inbox --mailbox pi-fleet-project-lead --unread",
    "fleet-mail send --from pi-fleet-project-lead --to conductor --type status --ticket FLT-68 --body rollup",
  ]) allow(command);
  for (const command of [
    "git commit -am x",
    "git clone https://example.invalid/r.git",
    "gh pr create --title t --body b",
    "gh pr review 1 --approve",
    "pnpm test",
    "npm ci",
    "node build.js",
    "python3 x.py",
    "bash script.sh",
  ]) deny(command);
});
