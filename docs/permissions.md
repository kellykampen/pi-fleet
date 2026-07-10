# Fleet permission policy (no click-ops)

Pi seats use **`@gotgenes/pi-permission-system`**. Popups appear when policy is `ask`.

## Layers (most specific wins)

| Layer | Path |
|---|---|
| Global | `~/.pi/agent/extensions/pi-permission-system/config.json` ← bootstrapped from `permission-system/config.json` |
| **Project** | `<repo>/.pi/extensions/pi-permission-system/config.json` |
| Per-agent (subagents) | `permission:` frontmatter in `agents/*.md` |

## Fleet defaults

**Project pi-fleet** enables:

- `"*": "allow"` for tools / skills / MCP  
- `external_directory: allow` (so skills under `~/code/pi-fleet` and `~/.agents` don’t prompt)  
- Still **deny** `.env`, `~/.ssh`, pipe-to-shell, `rm -rf /`  
- **`yoloMode: true`** on the project file only — any residual `ask` is auto-approved (no UI). Dangerous denials still block.

Global config keeps `yoloMode: false` so other repos can stay stricter; only this project is “hands-off.”

## Subagent frontmatter

`agents/project-lead.md` and `agents/conductor.md` use **`permission: "*": allow`** (with path/bash denials).  
Do **not** set `"*": ask` on lead seats — that forced a dialog on every `linear_*` / `e2b_*` / skill load.

Worker seats (reviewer, etc.) may stay tighter.

## New project setup

When creating a new product workspace that should not spam permission dialogs:

```bash
mkdir -p <repo>/.pi/extensions/pi-permission-system
cp ~/code/pi-fleet/.pi/extensions/pi-permission-system/config.json \
   <repo>/.pi/extensions/pi-permission-system/config.json
# edit denials as needed; yoloMode:true = no click-ops for ask leftovers
```

Or only drop a non-yolo allow policy if you want silent allow without auto-approving unknown `ask`s.

## After changing policy

Restart the seat (`Ctrl+D`, re-run `pi-project-lead` / `pi-conductor`).  
Re-run `bin/pi-fleet-bootstrap` after pulling so the **global** symlink matches `permission-system/config.json`.

## Layout rule

**One project lead per project workspace.**  
Conductor lives in the Conductor workspace (`~/.pi-fleet`). Workers are extra panes under the lead — never a second `pi-project-lead` in the same workspace.
