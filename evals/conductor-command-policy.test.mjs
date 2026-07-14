import assert from "node:assert/strict";
import test from "node:test";

import { evaluateCommand } from "../bin/lib/conductor-command-policy.mjs";

const routingProbe = ["pe", "ek"].join("");
const allow = (command, seat = "conductor", cwd = "/repo") =>
  assert.deepEqual(evaluateCommand(command, { seat, cwd }), { allowed: true });
const deny = (command, seat = "conductor", cwd = "/repo") =>
  assert.equal(evaluateCommand(command, { seat, cwd }).allowed, false, `${seat}: ${command}`);

test("allows the conductor orchestration and read command set", () => {
  for (const command of [
    "cmux workspace list --json",
    'cmux send --surface surface:12 "status && blockers"',
    "linear-cli issue get FLT-52",
    `${routingProbe} --help`,
    "check-model-usage",
    "gh pr view 42",
    "gh pr list --state open",
    "gh pr checks 42",
    "gh issue view 52",
    "git status --short",
    "git log -5 --oneline",
    "git diff origin/develop...HEAD",
    "git show HEAD:README.md",
    "git rev-parse HEAD",
    "git branch",
    "git branch --list 'flt-*'",
    "git -C /repo status --short",
    "cat README.md",
    "ls -la",
    "grep -n safety README.md",
    "rg safety .",
    "head -20 README.md",
    "tail -20 README.md",
    "wc -l README.md",
    "find . -maxdepth 2 -type f",
    "jq -r .state issue.json",
    "fleet-note append MORNING-ESCALATIONS.md status",
  ]) allow(command);
});

test("allows lead-only integration, worktree, evidence, and load commands", () => {
  for (const command of [
    "git checkout develop",
    "git switch develop",
    "git fetch --prune origin",
    "git pull --ff-only origin develop",
    "git merge --no-edit feature/FLT-52",
    "git push origin develop",
    "git worktree list",
    "git worktree add .worktrees/flt-52 -b flt-52 develop",
    "git worktree remove .worktrees/flt-52",
    "gh pr merge 42 --merge",
    "gh pr comment 42 --body gate-passed",
    "uptime",
  ]) allow(command, "lead");
});

test("denies lead-only integration commands to the conductor", () => {
  for (const command of [
    "git checkout develop",
    "git switch develop",
    "git fetch origin",
    "git pull --ff-only origin develop",
    "git merge feature/FLT-52",
    "git push origin develop",
    "git worktree list",
    "git worktree add .worktrees/flt-52 develop",
    "git worktree remove .worktrees/flt-52",
    "gh pr merge 42",
    "gh pr comment 42 --body done",
    "uptime",
  ]) deny(command);
});

test("denies implementation, research runtimes, and reviewer-only actions to both seats", () => {
  for (const seat of ["conductor", "lead"]) {
    for (const command of [
      "git clone https://example.invalid/repo.git",
      "git commit -am implementation",
      "npm ci",
      "pnpm install",
      "yarn test",
      "bun run build",
      "node build.js",
      "python3 script.py",
      "make test",
      "cargo build",
      "./configure",
      "bash script.sh",
      "sh script.sh",
      "sed -i '' s/a/b/ source.ts",
      "tee source.ts",
      "gh pr review 42 --approve",
      "git diff --output=bin/foo.sh HEAD",
      "git diff --ext-diff HEAD",
      "git show --textconv HEAD:file",
      "find . -delete",
      "find . -fprint bin/foo.sh",
      "curl https://example.com",
    ]) deny(command, seat);
  }
});

test("fails closed on compounds, pipelines, redirects, substitutions, wrappers, and parse errors", () => {
  for (const command of [
    "cmux workspace list && npm ci",
    "git status; git clone x",
    "git status | cat",
    "cat README.md > bin/foo.sh",
    "cmux workspace list &",
    "cmux send --surface surface:1 \"$(npm ci)\"",
    "cmux send --surface surface:1 '`npm ci`'",
    "env cmux workspace list",
    "sudo cmux workspace list",
    "bash -c 'cmux workspace list'",
    "find . -exec npm ci ;",
    "cmux send --surface 'unterminated",
    "",
  ]) deny(command);
});

test("keeps shell syntax inside a quoted cmux payload distinct from control flow", () => {
  allow('cmux send --surface surface:12 "cd /repo && pi-reviewer --model gpt-5.5"');
  allow('cmux send --workspace "${CMUX_WORKSPACE_ID}" --surface surface:12 "status; blockers"');
});

test("restricts lead integration targets and worktree destinations", () => {
  for (const command of [
    "git checkout feature/FLT-52",
    "git checkout -b implementation",
    "git switch feature/FLT-52",
    "git pull origin develop",
    "git pull --rebase --ff-only origin develop",
    "git worktree add ../escape develop",
    "git worktree add /tmp/escape develop",
    "git worktree remove ../escape",
    "git worktree prune",
    "git -C /repo merge feature/FLT-52",
  ]) deny(command, "lead");
});

test("rejects unknown seats", () => {
  deny("cmux workspace list", "implementer");
});
