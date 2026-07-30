import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import test from "node:test";
import { evaluateCommand } from "../bin/lib/conductor-command-policy.mjs";

test("permission-system directory is removed (FLT-67)", async () => {
  await assert.rejects(
    () => access(new URL("../permission-system/conductor.json", import.meta.url), constants.F_OK),
    /ENOENT/,
  );
});

test("conductor wrapper does not load pi-permission-system", async () => {
  const wrapper = await readFile(new URL("../bin/pi-conductor", import.meta.url), "utf8");
  // Comments may mention the removed package; operational wiring must be absent.
  assert.equal(/export\s+PI_PERMISSION_SYSTEM_PATH|PI_PERMISSION_SYSTEM_PATH\s*=/.test(wrapper), false);
  assert.equal(/--extension[^\n]*@gotgenes\/pi-permission-system|npm\/node_modules\/@gotgenes\/pi-permission-system/.test(wrapper), false);
  assert.match(wrapper, /--approve/);
  assert.match(wrapper, /conductor-policy\.ts/);
  const toolsLine = wrapper.split("\n").find((line) => /--tools\s+/.test(line) && !line.trim().startsWith("#")) ?? "";
  assert.match(toolsLine, /--tools bash,linear_get_issue/);
  assert.doesNotMatch(toolsLine, /\b(write|edit|read|grep|find)\b/);
});

test("conductor-policy.ts evaluates seat conductor", async () => {
  const policy = await readFile(new URL("../extensions/conductor-policy.ts", import.meta.url), "utf8");
  assert.match(policy, /seat:\s*"conductor"/);
});

// FLT-65: conductor is routing/metadata only — no product PR view/diff investigation.
// FLT-67: policy is enforced by conductor-command-policy.mjs (not permission-system JSON).
test("seat conductor command policy allows orchestration and denies product review / implementation", () => {
  const allow = (command) =>
    assert.equal(evaluateCommand(command, { seat: "conductor", cwd: "/repo" }).allowed, true, command);
  const deny = (command) =>
    assert.equal(evaluateCommand(command, { seat: "conductor", cwd: "/repo" }).allowed, false, command);
  for (const command of [
    "cmux workspace list",
    "linear-cli issue get FLT-1",
    "gh pr list --state open",
    "gh pr checks 1",
    "git status --short",
    "uptime",
    "fleet-note append coordination/status.md ok",
    "fleet-mail inbox --mailbox conductor --unread",
  ]) allow(command);
  for (const command of [
    "gh pr view 1",
    "gh api repos/o/r/pulls/1",
    "git clone https://example.invalid/r.git",
    "git merge feature/x",
    "git push origin main",
    "gh pr merge 1 --merge",
    "npm ci",
    "pnpm test",
    "node build.js",
    "bash script.sh",
  ]) deny(command);
});
