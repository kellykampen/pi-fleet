# Fleet permission policy (FLT-67)

**`@gotgenes/pi-permission-system` is fully removed from pi-fleet.** Seats never load it, never
install it, and never prompt for tool approval. CEO intent: **always YOLO** — every Pi wrapper
passes `--approve` unconditionally.

Security is **not** interactive permission UI. It is:

1. **Wrapper `--tools` allowlists** (hard capability ceiling per seat).
2. **Immutable command-policy extensions** for restricted bash seats:
   - `extensions/conductor-policy.ts` (seat `conductor`)
   - `extensions/project-lead-policy.ts` (seat `lead`)
   - `extensions/ac-verifier-policy.ts` (verifier bash gate)
   Shared evaluator: `bin/lib/conductor-command-policy.mjs`.
3. **Hard secret / path denials** only where still encoded in policy or tooling (never via PS).

There is **no** `permission-system/` directory, **no** `PI_PERMISSION_SYSTEM_PATH`, and **no**
agent `permission:` frontmatter. Agent capability is the wrapper `--tools` list + policy extensions.

## Always YOLO

All Pi wrappers pass `--approve` always (not gated on `FLEET_YOLO`). `FLEET_YOLO` may still appear
in older secrets files as an ignored operational key; it does not control approval.

Headless `-p` smokes and unattended QC must never hit allow-modals: `--approve` + no PS extension.

## Restricted conductor (Pi)

`bin/pi-conductor` (FLT-65 routing-only + FLT-67 no PS):

1. `--tools` is **bash + Linear only** — omits `read`/`grep`/`find`/`ls`/`write`/`edit` so the seat
   cannot investigate product-repo source or PR diffs in-session.
2. Always `--approve` + `--no-extensions`.
3. Explicit extensions: Linear, `conductor-policy.ts`, optional `pi-xai-oauth`.
4. Isolated agent overlay + policy cwd (`bin/lib/pi-conductor-runtime.sh`) keep coordination root
   as `FLEET_COORDINATION_ROOT` / `launch-cwd/` — **not** for PS isolation (PS is gone).
5. `extensions/conductor-policy.ts` enforces the executable/subcommand allowlist and rejects shell
   control flow, redirects, substitutions, wrappers, product PR investigation (`gh pr view`,
   `git diff`/`show`, content readers), and parse uncertainty.

## Restricted project-lead (Pi)

`bin/pi-project-lead` mirrors conductor with seat `lead`:

1. `--tools` omits `write` and `edit` (coordination + Linear + E2B only).
2. Always `--approve` + `--no-extensions`.
3. Explicit extensions: Linear, E2B, `project-lead-policy.ts`, optional `pi-xai-oauth`.
4. Isolated runtime via `bin/lib/pi-project-lead-runtime.sh`.
5. `extensions/project-lead-policy.ts` enforces `evaluateCommand(..., { seat: "lead" })`.

**Keeps coordination power:** `cmux` cast/send/capture, Linear read/comment/update, read utilities,
`gh pr view/list/checks`, `gh pr merge/comment`, narrow main-integration git, `fleet-note`,
`fleet-mail`, `uptime`, E2B cast tools.

**Loses product-implementation power:** no `write`/`edit`; no `git commit` / `git clone`; no
`gh pr create` / `gh pr review`; no package managers/interpreters as the doer. Implementation,
review, AC-verify, and docs work must be cast.

## Unattended QC seats (reviewer + AC verifier)

`bin/pi-reviewer` and `bin/pi-ac-verifier`:

1. Always `--approve` + `--no-extensions`.
2. Never load any permission package.
3. Security = wrapper `--tools` (+ `ac-verifier-policy.ts` for AC bash).
4. Reviewer has no bash; AC-verifier bash is validation-only.

Eval: `evals/unattended-reviewer-ac-smoke-test.sh` (also proves lead/conductor/implementer have no PS).

## AC verifier comment-only PR evidence policy

Unchanged in intent from FLT-54/56/60:

1. No `write`/`edit`.
2. `github_pr_view` / `github_pr_comment` only for PR evidence.
3. `ac-verifier-policy.ts` blocks shell control flow, git writes, raw `gh pr comment`, and
   arbitrary package-manager/interpreter execution.
4. Parent fans out `ac-criterion-verifier` children via `pi-subagents`; children are verify-only.

## Validated coordination notes

Conductor and project-lead may invoke `fleet-note` and `fleet-mail` through their restricted Bash
policy. See [`agent-mail.md`](./agent-mail.md).

## Claude conductor and project-lead policies

Unchanged: Claude seats use `claude-settings/*.json` + `PreToolUse` hook
(`bin/claude-bash-policy-hook` / `bin/lib/claude-bash-policy-hook.mjs`) and
`--disallowedTools "Edit Write NotebookEdit"` with mode `dontAsk`. No Pi permission-system.

## New project setup

Do **not** install `@gotgenes/pi-permission-system`. Do **not** copy any permission-system config
into product repositories. Run `setup.sh` / `bin/pi-fleet-bootstrap` for MCP + agents only.

## After changing policy

Restart the affected seat. For conductor restrictions:

```bash
bin/pi-fleet-eval-conductor-policy
```

For project-lead:

```bash
evals/pi-project-lead-launch-smoke-test.sh
evals/pi-project-lead-config.test.mjs
evals/project-lead-delegate-guard-structural-test.sh
node --test evals/conductor-command-policy.test.mjs
```

For fleet-wide no-PS + always YOLO:

```bash
evals/unattended-reviewer-ac-smoke-test.sh
bin/pi-fleet-eval-bashpolicy
bin/pi-fleet-eval-model-overrides
```

## Layout rule

**One project lead per project workspace.** Conductor lives in the Conductor workspace. Workers are
extra panes under the lead—never a second project lead in the same workspace.
