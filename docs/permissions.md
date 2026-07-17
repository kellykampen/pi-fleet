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

`bin/pi-conductor` has a separate structural boundary:

1. Its `--tools` list omits `write` and `edit`.
2. It explicitly loads `@gotgenes/pi-permission-system` with
   `permission-system/conductor.json`, whose Bash fallback is `deny`.
3. It starts Pi from a dedicated policy cwd with an isolated agent overlay. The caller's cwd is retained
   as `FLEET_COORDINATION_ROOT` and exposed readably at `launch-cwd/`, without loading its `.pi` policy.
4. `extensions/conductor-policy.ts` independently enforces the same executable/subcommand allowlist and
   rejects shell control flow, redirects, substitutions, wrappers, and parse uncertainty.

The isolated cwd matters because the permission package's normal merge order lets a project config override
a global config. Without isolation, a caller repository could set `bash: { "*": "allow" }`. The dedicated
conductor-policy eval creates exactly that permissive caller config and proves with execution sentinels that
it does not weaken the seat.

The permission package's `path` surface is access-mode-blind: a path denial blocks reads and writes alike.
Runtime probing confirmed it cannot preserve broad reads while selectively allowing coordination writes.
Consequently, conductor seats have no general file-mutation tool.

## Validated coordination notes

Both conductor and native project-lead seats can invoke `fleet-note` through their restricted Bash policy.
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

- `claude-settings/conductor.json` — orchestration, read commands, and zero-argument `uptime`; merge flow denied.
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

Do not copy the conductor config into product repositories; its wrapper builds the isolated overlay.

## After changing policy

Restart the affected seat. Re-run `bin/pi-fleet-bootstrap` after changes to the general global policy.
For conductor restrictions, run:

```bash
bin/pi-fleet-eval-conductor-policy
```

## Layout rule

**One project lead per project workspace.** Conductor lives in the Conductor workspace. Workers are extra
panes under the lead—never a second project lead in the same workspace.
