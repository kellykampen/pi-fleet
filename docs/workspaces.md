# Workspace registry (`workspaces.json`) — FLT-69

Persistent mapping from cmux workspaces / local checkouts to fleet project metadata.

## Path

```text
$PI_FLEET_HOME/workspaces.json   # default ~/.pi-fleet/workspaces.json (mode 0600)
```

`PI_FLEET_HOME` follows the [runtime-state contract](./runtime-state.md): absolute,
normalized, non-root. The registry is a **top-level named file** under the runtime root
(not an ad-hoc namespace); the owning writer is `fleet-workspaces` /
`bin/lib/fleet-workspaces.cjs`.

## Edit path / CLI

```bash
# Print path
fleet-workspaces path

# Seed defaults if missing
fleet-workspaces init

# Inspect
fleet-workspaces list
fleet-workspaces show pi-fleet
fleet-workspaces sample          # same as docs/workspaces.sample.json

# Resolve (slug/alias → cmux title → cwd/repo → basename)
fleet-workspaces resolve --cwd "$PWD"
fleet-workspaces resolve --title pi-fleet --json
fleet-workspaces resolve --cwd "$PWD" --env   # shell exports for FLEET_* vars
```

You may also edit `$PI_FLEET_HOME/workspaces.json` by hand after `init`. Schema:
[`workspaces.schema.v1.json`](./workspaces.schema.v1.json). Sample:
[`workspaces.sample.json`](./workspaces.sample.json).

## Schema (version 1)

```json
{
  "version": 1,
  "workspaces": {
    "<slug>": {
      "cmuxTitles": ["…"],
      "aliases": ["…"],
      "cwdMatchers": ["…"],
      "repoMatchers": ["…"],
      "linear": { "teamKey": "FLT" },
      "leadMailbox": "pi-fleet-project-lead",
      "allowedRepoRoots": ["/absolute/repo/root"],
      "notes": "optional"
    }
  }
}
```

### Defaults

| slug | teamKey | leadMailbox | cwdMatchers |
| --- | --- | --- | --- |
| `fantastic-dev` | `FTD` | `ftd-project-lead` | `fantastic-dev` |
| `pi-fleet` | `FLT` | `pi-fleet-project-lead` | `pi-fleet` |

`leadMailbox` **must** align with the FLT-68 seat name form `<workspace>-project-lead`
(with the established short form `ftd-project-lead` for fantastic-dev).

## Resolution order

First match wins:

1. **slug / alias** (`FLEET_WORKSPACE_SLUG`, `FLEET_PROJECT_KEY`, `CMUX_WORKSPACE_NAME`, or CLI `--slug`/`--alias`)
2. **cmux title** (`CMUX_WORKSPACE_TITLE` / `--title`, matched against `cmuxTitles`, then sanitized as alias)
3. **cwdMatchers** then **repoMatchers** against launch cwd / `git remote get-url origin` / toplevel
4. **basename** of cwd (worktree-aware: `…/<repo>/.worktrees/<leaf>` → `<repo>`)

Built-in defaults are merged under file entries when the file exists so missing default
slugs remain available.

## Hard-enforced vs instruction-only

| Behavior | Enforcement |
| --- | --- |
| Registry load + resolve at **project-lead** launch | **Hard** — `bin/lib/pi-project-lead-runtime.sh` sources `fleet-workspaces.sh` and exports `FLEET_*` |
| `FLEET_LEAD_MAILBOX` / `FLEET_PROJECT_KEY` derived from registry | **Hard** — exported for the seat process |
| `FLEET_ALLOWED_REPO_ROOTS` derived (registry list, else git toplevel / cwd) | **Hard** — exported; lead bash policy rejects `git -C` outside roots |
| Worker inheritance of `FLEET_ALLOWED_REPO_ROOTS` / `FLEET_MAIL_TO` | **Hard** for env inheritance when cast from the lead process environment; worker wrappers do not re-resolve |
| Conductor maps cmux list → registry after workspace discovery | **Instruction + helper** — skill requires load; `fleet_workspaces_map_cmux_list` / `fleet-workspaces resolve` available; conductor has no product-repo write surface |
| Cross-project casts / panes | **Instruction-only** in skills (topology + workspace scoping); not a kernel sandbox |
| Manual edits to `workspaces.json` | Operator-owned; invalid JSON/schema **fail closed** on next load |

## Seat wiring

### `pi-project-lead`

On prepare runtime:

1. Resolve workspace from env + launch cwd.
2. Export `FLEET_WORKSPACE_SLUG`, `FLEET_LEAD_MAILBOX` (`<ws>-project-lead`), `FLEET_LINEAR_TEAM_KEY`, `FLEET_ALLOWED_REPO_ROOTS`, `FLEET_WORKSPACES_PATH`.
3. Workers cast from that environment inherit the same roots / mail target.

### `pi-conductor`

Startup protocol (skill): after `cmux workspace list --json`, load the registry and map
each non-Conductor workspace to `leadMailbox` / `linear.teamKey` before check-in. Use:

```bash
cmux workspace list --json | fleet_workspaces_map_cmux_list
# or
fleet-workspaces resolve --title "<cmux title>" --json
```

Conductor remains routing-only (FLT-65): the registry is portfolio metadata, not a license
to open product repos.

## Smoke / tests

```bash
node --test evals/fleet-workspaces.test.mjs
evals/fleet-workspaces-structural-test.sh
evals/pi-project-lead-launch-smoke-test.sh
```
