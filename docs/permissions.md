# Fleet permission policy

Pi seats use **`@gotgenes/pi-permission-system`**. Claude conductor-class seats use Claude's native
permissions plus a fleet `PreToolUse` command gate.

## General Pi policy layers

| Layer | Path |
| --- | --- |
| Global | `~/.pi/agent/extensions/pi-permission-system/config.json` ← bootstrapped from `permission-system/config.json` |
| Project | `<repo>/.pi/extensions/pi-permission-system/config.json` |
| Per-agent (subagents) | `permission:` frontmatter in `agents/*.md` |

Project rules normally override global rules. General fleet configs allow registered tools while retaining
denials for sensitive paths and destructive shell forms. `yoloMode` only auto-approves `ask`; it never
turns an explicit `deny` into an allow.

## Restricted conductor policy

`bin/pi-conductor` has a separate structural boundary (FLT-52 + **FLT-65 routing-only**):

1. Its `--tools` list is **routing-only**: `bash,linear_get_issue,linear_list,linear_comment,linear_update`.
   It omits `write`, `edit`, and product-investigation tools (`read`, `grep`, `find`, `ls`).
2. It explicitly loads `@gotgenes/pi-permission-system` with
   `permission-system/conductor.json`, whose Bash fallback is `deny`.
3. It starts Pi from a dedicated policy cwd with an isolated agent overlay. The caller's cwd is retained
   as `FLEET_COORDINATION_ROOT` and exposed readably at `launch-cwd/`, without loading its `.pi` policy.
4. `extensions/conductor-policy.ts` independently enforces the same executable/subcommand allowlist and
   rejects shell control flow, redirects, substitutions, wrappers, and parse uncertainty.

**FLT-65 product-review / in-repo investigation denies (conductor seat only):**

- **Denied:** `git diff`, `git show`, `gh pr view`, `gh api`, content readers
  (`cat`/`grep`/`rg`/`head`/`tail`/`wc`/`find`), package managers/interpreters, merge/implement paths.
- **Allowed portfolio metadata / routing:** `cmux`, `linear-cli`, Linear tools, `gh pr list`,
  `gh pr checks`, `gh issue view`, `git status`/`log`/`branch`/`rev-parse` (and the same via
  `git -C`), `ls`, `jq`, `uptime`, `fleet-note`, `fleet-mail`, `check-model-usage`.

Project leads keep `gh pr view` and content readers for gate holding; they still must not absorb
product implementation/review as doers (see Restricted project-lead policy).

The isolated cwd matters because the permission package's normal merge order lets a project config override
a global config. Without isolation, a caller repository could set `bash: { "*": "allow" }`. The dedicated
conductor-policy eval creates exactly that permissive caller config and proves with execution sentinels that
it does not weaken the seat.

The permission package's `path` surface is access-mode-blind: a path denial blocks reads and writes alike.
Runtime probing confirmed it cannot preserve broad reads while selectively allowing coordination writes.
Consequently, conductor seats have no general file-mutation tool and no product content-read tool surface.

## Restricted project-lead policy

`bin/pi-project-lead` mirrors the conductor structural boundary with seat `lead`:

1. Its `--tools` list omits `write` and `edit` (coordination + Linear + E2B only).
2. It explicitly loads `@gotgenes/pi-permission-system` with
   `permission-system/project-lead.json`, whose Bash fallback is `deny`.
3. It starts Pi from a dedicated policy cwd with an isolated agent overlay
   (`FLEET_PROJECT_LEAD_RUNTIME_DIR` / `bin/lib/pi-project-lead-runtime.sh`). The caller's cwd is
   retained as `FLEET_COORDINATION_ROOT` and exposed readably at `launch-cwd/`.
4. `extensions/project-lead-policy.ts` independently enforces the shared
   `evaluateCommand(..., { seat: "lead" })` allowlist from
   `bin/lib/conductor-command-policy.mjs`.

**Keeps coordination power:** `cmux` cast/send/capture, Linear read/comment/update, read utilities,
`gh pr view/list/checks`, `gh pr merge/comment`, narrow main-integration git (`fetch`, ff-only
`pull`, `checkout`/`switch main`, `merge`, `push origin <one-ref>`, worktree lifecycle under
`.worktrees/`), `fleet-note`, `fleet-mail`, `uptime`, and E2B cast tools.

**Loses product-implementation power:** no `write`/`edit`; no `git commit` / `git clone`; no
`gh pr create` / `gh pr review`; no `npm`/`pnpm`/`yarn`/`bun`/`node`/`python`/`make`/`cargo` or
arbitrary scripts as the doer. Implementation, review, AC-verify, and docs work must be cast.

Instructions in the skill/profile are not the capability ceiling — the wrapper + isolated policy +
immutable extension are.

## Unattended QC seats (reviewer + AC verifier) — FLT-60

`bin/pi-reviewer` and `bin/pi-ac-verifier` are **unattended** QC seats. They must complete review / AC
verification without any permission modal or "allow this bash" prompt.

1. Both wrappers always pass `--approve` (project trust) and **`--no-extensions`**. They do **not**
   load `@gotgenes/pi-permission-system`. Interactive ask gates cannot appear because the extension
   that emits them is not present.
2. Security boundary remains the wrapper **`--tools` allowlist** (plus, for AC-verifier, the immutable
   `extensions/ac-verifier-policy.ts` Bash gate). No write/edit on either seat; reviewer has no bash.
3. `--approve` is **not** gated on `FLEET_YOLO` for these two seats (unlike implementer / conductor /
   project-lead). Conductor and project-lead retain their isolated permission overlays and
   FLEET_YOLO-gated `--approve` — do not widen those wrappers.
4. Agent `permission:` frontmatter for `reviewer`, `ac-verifier`, and `ac-criterion-verifier` uses
   deny-by-default with explicit `allow` for allowlisted tools and **no `ask` states**, so even if a
   future change re-introduced the permission package, QC seats stay prompt-free.

Eval: `evals/unattended-reviewer-ac-smoke-test.sh`.

## AC verifier comment-only PR evidence policy

`bin/pi-ac-verifier` has a verifier-specific boundary for PR verification:

1. Its `--tools` list omits `write` and `edit`.
2. It exposes `github_pr_view` and `github_pr_comment` from `extensions/github-pr.ts` so the verifier can
   read the PR body/head SHA and MUST post AC evidence to the PR itself.
3. `github_pr_comment` is comment-only: it shells out to `gh pr comment` and does not expose approve,
   request-changes, merge, edit, close, push, or review authority.
4. `extensions/ac-verifier-policy.ts` blocks Bash shell control flow/redirects, denies Git writes
   (`commit`, `checkout`, `switch`, `merge`, `rebase`, `push`), denies raw `gh pr comment` so PR
   comments can only go through the dedicated tool, and rejects arbitrary package-manager/interpreter
   execution such as code-eval flags (`-e`, `-c`, `--eval`, `--print`), arbitrary `npx`, installs, or `pnpm exec`. Only explicit validation
   subcommands such as `pnpm test`, `pnpm build`, `pnpm typecheck`, `npx vitest run`, and
   `npx tsc --noEmit` are allowed.
5. FLT-56: the parent allowlist includes the `subagent` tool and the wrapper loads `pi-subagents` under
   `--no-extensions` so AC verification can fan out one `ac-criterion-verifier` child per criterion.
   Children are verify-only (bash + read/search; no write/edit, no Linear/PR mutation tools, no nested
   `subagent`). Only the parent synthesizes results, posts dual-source evidence, and checks passed boxes.
6. FLT-60: the wrapper never loads the permission-system package; bash is gated solely by
   `ac-verifier-policy.ts` + the `--tools` list (see Unattended QC seats above).

This preserves the no-code-change boundary while fixing the previous failure mode where a verifier could
verify AC but had no constrained path to post evidence on GitHub, and while allowing parallel per-criterion
verification without giving children mutation authority.

## Validated coordination notes

Both conductor and project-lead seats (Pi and Claude native) can invoke `fleet-note` and `fleet-mail` through their restricted Bash policy. `fleet-mail` is the durable async inbox for status uplink (see [`agent-mail.md`](./agent-mail.md)); topology and anti-spam are enforced inside the CLI.
The helper receives its root from the launcher, not from model arguments. It supports only `append` and
`write`, rejects absolute paths and `..`, resolves existing parents and targets, rejects symlink escapes,
and permits only:

- `.claude/orchestration/ORCHESTRATION-HANDOFF.md`;
- `.claude/orchestration/MORNING-ESCALATIONS.md`;
- `.claude/orchestration/ORCHESTRATOR-PLAYBOOK.md`;
- files below `coordination/`.

Matching basenames elsewhere in the project tree are not writable.

This is the only direct write path for these restricted seats.

## Claude conductor and project-lead policies

The wrappers load separate settings files:

- `claude-settings/conductor.json` — orchestration + portfolio metadata only (no product Read/Grep/Glob,
  no `gh pr view` / `git diff` / `git show` / content readers); zero-argument `uptime`; merge flow denied.
- `claude-settings/project-lead.json` — the conductor set plus main integration, PR merge/comment,
  merge preparation, and worktree lifecycle.

Both pass `--disallowedTools "Edit Write NotebookEdit"` and use the real Claude mode `dontAsk`, which
auto-denies commands not pre-approved by native permissions. Native `permissions.allow` mainly suppresses
prompts; it is not the security boundary.

Claude Bash rules are prefix-based, so a command beginning with an allowed prefix can otherwise hide a
second verb in a compound expression. The authoritative `PreToolUse` hook therefore parses every Bash
request itself and fails closed. Outside quoted `cmux send` message payloads, one Bash call must contain one
atomic command. Compounds, pipelines, redirects, substitutions, interpreter/indirection wrappers, unknown
executables, and parse failures are blocked. For both seats, `git -C <path>` is accepted only when the
parsed subcommand is read-only (`status`, `log`, `diff`, `show`, `rev-parse`, or listing branches); `-C`
never enables checkout, commit, fetch, pull, merge, push, or worktree operations. Lead integration verbs are
also shape-restricted: network operations target only `origin`, pull requires `--ff-only`, push carries one
ref, merge carries one local ref, and Git transport/executable override options are denied. Unexpected hook
exceptions exit with Claude's blocking status instead of failing open. `FLEET_YOLO` does not add Claude's
permission-bypass flag to these wrappers.

## New project setup

For ordinary Pi seats that should not prompt on routine operations:

```bash
mkdir -p <repo>/.pi/extensions/pi-permission-system
cp ~/code/pi-fleet/permission-system/config.json \
   <repo>/.pi/extensions/pi-permission-system/config.json
```

Do not copy the conductor or project-lead configs into product repositories; their wrappers build the isolated overlay.

## After changing policy

Restart the affected seat. Re-run `bin/pi-fleet-bootstrap` after changes to the general global policy.
For conductor restrictions, run:

```bash
bin/pi-fleet-eval-conductor-policy
```

For project-lead restrictions (tools, policy config, launch overlay, prose), run:

```bash
evals/pi-project-lead-launch-smoke-test.sh
evals/pi-project-lead-config.test.mjs
evals/project-lead-delegate-guard-structural-test.sh
node --test evals/conductor-command-policy.test.mjs
```

For AC-verifier PR-evidence and dual-source AC rules, run:

```bash
evals/ac-verification-dual-source-structural-test.sh
```

For unattended reviewer / AC-verifier (no permission-system ask gate), run:

```bash
evals/unattended-reviewer-ac-smoke-test.sh
```

## Layout rule

**One project lead per project workspace.** Conductor lives in the Conductor workspace. Workers are extra
panes under the lead—never a second project lead in the same workspace.
