import assert from "node:assert/strict";
import test from "node:test";

import { evaluateCommand } from "../bin/lib/conductor-command-policy.mjs";

const allow = (command, seat = "conductor", cwd = "/repo") =>
	assert.deepEqual(evaluateCommand(command, { seat, cwd }), { allowed: true });
const deny = (command, seat = "conductor", cwd = "/repo") =>
	assert.equal(
		evaluateCommand(command, { seat, cwd }).allowed,
		false,
		`${seat}: ${command}`,
	);

test("allows the conductor routing and portfolio-metadata command set (FLT-65)", () => {
	for (const command of [
		"cmux workspace list --json",
		'cmux send --surface surface:12 "status && blockers"',
		"linear-cli issue get FLT-52",
		"check-model-usage",
		"gh pr list --state open",
		"gh pr checks 42",
		"gh issue view 52",
		"git status --short",
		"git log -5 --oneline",
		"git rev-parse HEAD",
		"git branch",
		"git branch --list 'flt-*'",
		"uptime",
		"ls -la",
		"jq -r .state issue.json",
		"fleet-note append .claude/orchestration/MORNING-ESCALATIONS.md status",
		"fleet-mail inbox --mailbox conductor --unread",
		"fleet-mail show --mailbox conductor",
		"fleet-mail ack --mailbox conductor --id abc123",
		'fleet-mail send --from project-lead --to conductor --type status --ticket FLT-58 --body rollup',
	])
		allow(command);
});

test("denies conductor product PR-diff / in-repo investigation commands (FLT-65)", () => {
	for (const command of [
		"gh pr view 42",
		"gh pr view 42 --json body",
		"gh pr view 42 --patch",
		"gh api repos/o/r/pulls/42",
		"gh api repos/o/r/pulls/42/files",
		"git diff origin/main...HEAD",
		"git show HEAD:README.md",
		"git -C /repo diff HEAD~1",
		"git -C /repo show HEAD:README.md",
		"cat README.md",
		"grep -n safety README.md",
		"rg safety .",
		"head -20 README.md",
		"tail -20 README.md",
		"wc -l README.md",
		"find . -maxdepth 2 -type f",
	])
		deny(command);
});

test("allows lead-only integration, worktree, and evidence commands", () => {
	for (const command of [
		"git checkout main",
		"git switch main",
		"git fetch origin",
		"git fetch --prune origin main",
		"git pull --ff-only origin main",
		"git push origin main",
		"git push origin HEAD",
		"git merge FETCH_HEAD",
		"git merge --no-edit feature/FLT-52",
		"git worktree list",
		"git worktree add .worktrees/flt-52 -b flt-52 main",
		"git worktree remove .worktrees/flt-52",
		"gh pr merge 42 --merge",
		"gh pr comment 42 --body gate-passed",
		"gh pr view 42",
		"git diff origin/main...HEAD",
		"git show HEAD:README.md",
		"cat README.md",
		"rg safety .",
	])
		allow(command, "lead");
});

test("allows git -C only when followed by a seat-appropriate read-only subcommand", () => {
	for (const seat of ["conductor", "lead"]) {
		for (const command of [
			"git -C /repo status",
			"git -C /repo status --short",
			"git -C ../repo log -5 --oneline",
			"git -C /repo rev-parse HEAD",
			"git -C /repo branch",
			"git -C /repo branch --list",
			"git -C /repo branch --list 'flt-*'",
		])
			allow(command, seat);

		for (const command of [
			"git -C /repo clone https://example.invalid/repo.git",
			"git -C /repo checkout main",
			"git -C /repo switch main",
			"git -C /repo commit -am implementation",
			"git -C /repo fetch origin",
			"git -C /repo pull --ff-only origin main",
			"git -C /repo merge feature/FLT-52",
			"git -C /repo push origin main",
			"git -C /repo worktree list",
		])
			deny(command, seat);
	}

	// Lead keeps content reads via git -C; conductor does not.
	for (const command of [
		"git -C '/repo with spaces' diff HEAD~1",
		"git -C /repo show HEAD:README.md",
	]) {
		allow(command, "lead");
		deny(command, "conductor");
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
		'git push --receive-pack="touch /tmp/push-rce" . main',
		'git push --receive-pack "touch /tmp/push-rce" origin main',
		'git push --exec="touch /tmp/push-rce" origin main',
		"git fetch .",
		"git fetch ../repo",
		"git fetch file:///repo",
		"git fetch 'ext::sh -c id'",
		"git pull --ff-only . main",
		"git push . main",
		"git fetch upstream",
		"git pull --ff-only upstream main",
		"git push upstream main",
		"git fetch origin --unknown-option",
		"git pull --ff-only origin main extra-ref",
		"git push origin",
		"git push origin HEAD extra-ref",
		"git merge --strategy=evil feature/FLT-52",
		"git merge /tmp/local-repo",
		"git merge file:///repo",
	])
		deny(command, "lead");
});

test("denies lead-only integration commands to the conductor", () => {
	for (const command of [
		"git checkout main",
		"git switch main",
		"git fetch origin",
		"git pull --ff-only origin main",
		"git merge feature/FLT-52",
		"git push origin main",
		"git worktree list",
		"git worktree add .worktrees/flt-52 main",
		"git worktree remove .worktrees/flt-52",
		"gh pr merge 42",
		"gh pr comment 42 --body done",
	])
		deny(command);
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
			"gh api repos/o/r/pulls/42",
			"git diff --output=bin/foo.sh HEAD",
			"git diff --ext-diff HEAD",
			"git show --textconv HEAD:file",
			"find . -delete",
			"find . -fprint bin/foo.sh",
			"uptime --pretty",
			"curl https://example.com",
		])
			deny(command, seat);
	}
});

test("fails closed on compounds, pipelines, redirects, substitutions, wrappers, and parse errors", () => {
	for (const command of [
		"cmux workspace list && npm ci",
		"git status; git clone x",
		"git status | cat",
		"cat README.md > bin/foo.sh",
		"cmux workspace list &",
		'cmux send --surface surface:1 "$(npm ci)"',
		"cmux send --surface surface:1 '`npm ci`'",
		"env cmux workspace list",
		"sudo cmux workspace list",
		"bash -c 'cmux workspace list'",
		"find . -exec npm ci ;",
		"cmux send --surface 'unterminated",
		"",
	])
		deny(command);
});

test("keeps shell syntax inside a quoted cmux payload distinct from control flow", () => {
	allow(
		'cmux send --surface surface:12 "cd /repo && pi-reviewer --model gpt-5.5"',
	);
	allow(
		'cmux send --workspace "${CMUX_WORKSPACE_ID}" --surface surface:12 "status; blockers"',
	);
});

test("restricts lead integration targets and worktree destinations", () => {
	for (const command of [
		"git checkout develop",
		"git switch develop",
		"git checkout feature/FLT-52",
		"git checkout -b implementation",
		"git switch feature/FLT-52",
		"git pull origin main",
		"git pull --rebase --ff-only origin main",
		"git worktree add ../escape main",
		"git worktree add /tmp/escape main",
		"git worktree remove ../escape",
		"git worktree prune",
		"git -C /repo merge feature/FLT-52",
	])
		deny(command, "lead");
});

test("rejects unknown seats", () => {
	deny("cmux workspace list", "implementer");
});
