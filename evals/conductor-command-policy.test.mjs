import assert from "node:assert/strict";
import test from "node:test";

import { evaluateCommand } from "../bin/lib/conductor-command-policy.mjs";

const allow = (command, seat = "conductor", cwd = "/repo") =>
  assert.deepEqual(evaluateCommand(command, { seat, cwd }), { allowed: true });
const deny = (command, seat = "conductor", cwd = "/repo") =>
  assert.equal(evaluateCommand(command, { seat, cwd }).allowed, false, `${seat}: ${command}`);

test("allows the conductor orchestration and read command set", () => {
  for (const command of [
    "cmux workspace list --json",
    'cmux send --surface surface:12 "status && blockers"',
    "linear-cli issue get FLT-52",
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
    "uptime",
    "cat README.md",
    "ls -la",
    "grep -n safety README.md",
    "rg safety .",
    "head -20 README.md",
    "tail -20 README.md",
    "wc -l README.md",
    "find . -maxdepth 2 -type f",
    "jq -r .state issue.json",
    "fleet-note append .claude/orchestration/MORNING-ESCALATIONS.md status",
  ]) allow(command);
});

test("allows lead-only integration, worktree, and evidence commands", () => {
  for (const command of [
    "git checkout develop",
    "git switch develop",
    "git fetch origin",
    "git fetch --prune origin develop",
    "git pull --ff-only origin develop",
    "git push origin HEAD",
    "git merge FETCH_HEAD",
    "git merge --no-edit feature/FLT-52",
    "git worktree list",
    "git worktree add .worktrees/flt-52 -b flt-52 develop",
    "git worktree remove .worktrees/flt-52",
    "gh pr merge 42 --merge",
    "gh pr comment 42 --body gate-passed",
  ]) allow(command, "lead");
});

test("allows git -C only when followed by a read-only subcommand", () => {
  for (const seat of ["conductor", "lead"]) {
    for (const command of [
      "git -C /repo status",
      "git -C /repo status --short",
      "git -C ../repo log -5 --oneline",
      "git -C '/repo with spaces' diff HEAD~1",
      "git -C /repo show HEAD:README.md",
      "git -C /repo rev-parse HEAD",
      "git -C /repo branch",
      "git -C /repo branch --list",
      "git -C /repo branch --list 'flt-*'",
    ])
      allow(command, seat);

    for (const command of [
      "git -C /repo clone https://example.invalid/repo.git",
      "git -C /repo checkout develop",
      "git -C /repo switch develop",
      "git -C /repo commit -am implementation",
      "git -C /repo fetch origin",
      "git -C /repo pull --ff-only origin develop",
      "git -C /repo merge feature/FLT-52",
      "git -C /repo push origin develop",
      "git -C /repo worktree list",
    ])
      deny(command, seat);
  }
});

test("blocks lead git transport execution and unsafe remotes", () => {
  for (const command of [
    'git fetch --upload-pack="touch /tmp/fetch-rce;git-upload-pack" .',
    'git fetch --upload-pack "touch /tmp/fetch-rce;git-upload-pack" origin',
    'git fetch --upload-pack="touch /tmp/fetch-rce;git-upload-pack" origin',
    'git fetch -u="touch /tmp/fetch-rce;git-upload-pack" origin',
    'git fetch -u "touch /tmp/fetch-rce;git-upload-pack" origin',
    'git pull --ff-only --upload-pack="touch /tmp/pull-rce;git-upload-pack" .',
    'git push --receive-pack="touch /tmp/push-rce" . develop',
    'git push --receive-pack "touch /tmp/push-rce" origin develop',
    'git push --exec="touch /tmp/push-rce" origin develop',
    "git fetch .",
    "git fetch ../repo",
    "git fetch file:///repo",
    "git fetch 'ext::sh -c id'",
    "git pull --ff-only . develop",
    "git push . develop",
    "git fetch upstream",
    "git pull --ff-only upstream develop",
    "git push upstream develop",
    "git fetch origin --unknown-option",
    "git pull --ff-only origin develop extra-ref",
    "git push origin",
    "git push origin HEAD extra-ref",
    "git merge --strategy=evil feature/FLT-52",
    "git merge /tmp/local-repo",
    "git merge file:///repo",
  ]) deny(command, "lead");
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
      "fleet-note write src/deep/HANDOFF bad",
      "fleet-note write .claude/orchestration/OTHER-HANDOFF.md bad",
      "gh pr review 42 --approve",
      "git diff --output=bin/foo.sh HEAD",
      "git diff --ext-diff HEAD",
      "git show --textconv HEAD:file",
      "find . -delete",
      "find . -fprint bin/foo.sh",
      "uptime --pretty",
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
