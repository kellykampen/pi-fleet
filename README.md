# pi-fleet

Versioned, reusable **agent profiles** for the [Pi coding agent](https://pi.dev) — each one a
restricted "seat" with a fixed toolset, model, and skill. Launch any of them from the terminal
with a single command.

## Hierarchy

Fixed vocabulary for every skill, agent, and cast:

```
CEO  →  conductor  →  project lead  →  worker
(you)   (portfolio)   (one project)    (implementer, reviewer, …)
```

| Seat | Command | Owns |
|---|---|---|
| **CEO** | (human) | Goals, priorities, merge-to-main, risk/money |
| **Conductor** | `pi-conductor` | Cross-project routing; assigns project leads; escalates to CEO |
| **Project lead** | `pi-project-lead` | One project/stream; casts workers; holds QC gates; reports to conductor |
| **Worker** | `pi-implementer`, `pi-reviewer`, … | Single-purpose work; reports to the project lead |

**Cast** = spin up a worker seat (project lead → worker). The conductor assigns work to project
leads; it does not cast workers directly.

(`pi-orchestrator` remains a deprecated alias for `pi-project-lead`.)

Every profile is a **hybrid** of two pieces:

- **[outfitter](https://pi.dev/packages/@ai-outfitter/outfitter)** composes the loadout —
  model/provider, thinking level, skills, extensions, and system prompt — from versioned YAML
  in `profiles/`.
- A thin **wrapper script** in `bin/` hardcodes the `--tools` allowlist and launches Pi through
  outfitter. *Why the wrapper?* Outfitter's Pi adapter can't translate a tool allowlist, so tool
  restriction (the actual security boundary — e.g. a reviewer with no `bash`) lives in the
  wrapper, not the YAML. The wrapper forwards any extra args straight to Pi.

```
pi-<role>  ==  outfitter run --profile <role> --agent pi  --  --tools <allowlist>  "$@"
```

---

## The profiles

| Command | Model (default) | Tools | What it does |
|---|---|---|---|
| **`pi-implementer`** | GPT-5.6 Sol (`openai-codex`) · high | read, grep, find, ls, **write, edit, bash** + linear read | Builds one ticket end-to-end in a worktree (code + tests → PR). Override to Kimi `k2p7` for simple work. |
| **`pi-reviewer`** | Kimi K2.7 (`kimi-coding`) · medium | read, grep, find, ls + linear read *(no bash)* | Independent **read-only** code review/QC. Must run on a **different model** than the implementer. |
| **`pi-ac-verifier`** | Grok 4.5 (`xai-auth`) · high | read, grep, find, ls, **bash** + linear | **Runs** the acceptance-criteria verification (tests/build), checks the AC boxes only on real pass. Different model than the build. |
| **`pi-researcher`** | Kimi K2.7 · low | read, grep, find, ls | Read-only scouting / codebase investigation. |
| **`pi-doc-updater`** | Kimi K2.7 (`kimi-coding`) · low | read, grep, find, ls, **write, edit, bash** | Documentation-only hygiene for README/docs/changelog/operator notes after behavior changes. |
| **`pi-designer`** | GPT-5.6 Terra (`openai-codex`) · high | read, grep, find, ls, write, edit, bash | Design / architecture / API + planning docs (taste model). Hands build to `pi-implementer`. For **claude.ai design import/update**, use `claude-designer` instead. |
| **`claude-designer`** | Claude Code (`--agent claude`) | `mcp__claude_design__*` + Read/Grep/Glob/Edit/Write/Bash(git,pnpm,npm) | Reads/updates **claude.ai design** projects via the `claude_design` MCP and implements them. Runs **Claude Code, not pi** — claude_design's OAuth is gated to Claude Code's blessed client (pi's generic MCP OAuth is turned down). One-time `/design-login` if tools 401. |
| **`pi-planner`** | GPT-5.6 Terra · high | read, grep, find, ls, bash + linear | Breaks a feature into a Linear project + ≤3-pt issues with checkbox AC + blockers. |
| **`pi-security-reviewer`** | Grok 4.5 (`openrouter`) · high | read, grep, find, ls *(read-only)* | Security-focused review — reports exploitable vulns with severity + file:line. |
| **`pi-conductor`** | GPT-5.5 · high | read, grep, find, ls, write, edit, bash + linear | Cross-project router — assigns **project leads**, watches portfolio health, escalates to the CEO. Does not cast workers. |
| **`pi-project-lead`** | GPT-5.5 · high | read, grep, find, ls, write, edit, bash + linear | Owns one project — routes each task to the right worker + model (via **model-classifier**), casts seats, holds QC gates. |
| **`pi-visual-qa`** | Grok 4.5 (`xai-auth`) · high | read, grep, find, ls, **bash** *(+ image, playwright)* | **Captures** the app screenshot (playwright) and compares it to the design comp. Tears down anything it spawns. |
| **`pi-linear`** | Kimi K2.7 · low | read, grep, find, ls, **bash** + `linear_*` | Full Linear issue/project management (create, labels, relations, projects — via `linear-cli` + the `linear.ts` extension). |
| **`pi-personal-assistant`** | **GPT-5.6 Terra** (`openai-codex`) · medium | read, grep, find, ls, write, edit, bash + `linear_*` | The operator's **personal assistant** — social/X, comms, notes, tasks. Runs the CLIs below under a **draft → approval → execute** gate (nothing sends without an explicit per-item OK). |

Project leads cast **`pi-doc-updater`** after behavior changes to keep README files, docs, changelogs, and operator notes in sync.

### Remote-pi / relay policy

Only the **conductor** and **personal-assistant** seats load the `remote-pi` extension by default, so only they can be reached as CEO remote-control targets via the mobile relay. The conductor routes across projects; the personal assistant is the CEO's direct agent.

Project leads and workers do **not** load `remote-pi` by default. They remain reachable by the conductor through local cmux/agent-network means and are not exposed to the relay. If a project lead or worker ever needs to be reachable remotely for debugging, create a temporary override profile that adds `npm:remote-pi` to its `cli_specific/pi/settings.json` and run `/remote-pi` in that session.

The `pi-personal-assistant` toolkit (all via `bash`, documented in its skill):
`finch` (X) · `gog` (Google Workspace) · `imsg` (iMessage) · `wacli` (WhatsApp) ·
`obsidian-cli` (Obsidian) · `ntn` (Notion) · `linear-cli` · `gh`/`git`.

**Models are defaults, not locks.** Each profile's model is a sensible fallback so `pi-<role>` runs
standalone — but the **`pi-project-lead`** picks the model per task using the **model-classifier
skill** (loaded into it) and overrides via `--provider/--model` on the cast. So routing = "which
worker profile + which model," decided per task, not baked rigidly into the profile.

---

## Two ways to run a role: top-level seat vs. spawnable subagent

pi-fleet composes **three upstream packages** — nothing is forked:

| Layer | Package | Role |
|---|---|---|
| Loadout + CLI launch | **outfitter** | Composes model/skills/extensions/system-prompt into a profile; the `bin/pi-<role>` wrapper launches it and hardcodes the `--tools` allowlist. |
| Spawnable subagents | **pi-subagents** | Lets a running seat *delegate* to a child agent (chains, parallel, background). Roster lives in `agents/*.md`. |
| Runtime policy | **@gotgenes/pi-permission-system** | `allow`/`ask`/`deny` per tool **and per bash command** (e.g. `git *: allow`, `rm -rf *: deny`). Global baseline in `permission-system/config.json`; per-agent `permission:` frontmatter tightens it. |

So each role exists in two forms:
- **Top-level seat** — `bin/pi-<role>` (outfitter + `--tools`). Start it yourself from a terminal.
- **Spawnable subagent** — `agents/<role>.md`, discovered globally at `~/.pi/agent/agents/`. Any seat
  (typically `pi-project-lead`) delegates to it via the `subagent` tool. Its `tools:` frontmatter is
  the visibility allowlist; `permission:` is the bash/CLI policy. Read-only roles
  (`reviewer`, `researcher`, `security-reviewer`) carry no `bash`/`write`/`edit` **by construction**.

### Machine setup + durability

```bash
bin/pi-fleet-bootstrap   # symlink mcp.json, agents/, permission config into ~/.pi; re-apply patches
bin/pi-fleet-repair      # idempotently re-apply the outfitter + pi-tui patches (run after any update)
bin/pi-fleet-eval        # prove each seat's --tools allowlist really enforces read/write/bash
```

Two patches (auto-reverted by `outfitter update` / `pi update`, so `pi-fleet-repair` re-applies them):
1. **outfitter** — persist `pi-mcp-adapter`'s OAuth/onboarding state (else it's wiped each launch).
2. **pi-tui** — truncate overflowing lines instead of crashing pi (narrow panes overflow the banner).

Required global pi packages: `pi-mcp-adapter`, `pi-subagents`, `@gotgenes/pi-permission-system`.

---

## How to start a profile

The wrappers live in `bin/` and are on your `$PATH` (see setup below). From any terminal:

```bash
# cd to where you want the agent to work, then run the wrapper:
cd ~/code/tiny-projects/kellyk-dev && pi-personal-assistant

# any extra args forward straight to Pi:
pi-reviewer --provider openrouter --model x-ai/grok-4.5   # override the model for this run
pi-personal-assistant -p "draft a reply to my latest mention"   # one-shot, non-interactive
```

Supporting commands:

```bash
outfitter profile list                                  # list all profiles
outfitter run --profile personal-assistant --agent pi   # raw launch (SKIPS --tools enforcement — prefer the wrapper)
```

---

## PATH setup (the zsh linking)

`bin/` is put on `$PATH` with one line in `~/.zshrc`:

```bash
export PATH="$HOME/code/pi-fleet/bin:$PATH"
```

If the wrappers aren't found (`command not found: pi-reviewer`):

```bash
grep -q 'pi-fleet/bin' ~/.zshrc || echo 'export PATH="$HOME/code/pi-fleet/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc        # or just open a new terminal
```

Outfitter must also know where the profiles live — that's set once in `~/.outfitter/settings.yml`:

```yaml
profile_sources:
  - path: /Users/<you>/code/pi-fleet/profiles
```

---

## Repo layout

```
pi-fleet/
├── profiles/<role>/profile.yml   # outfitter loadout: model, thinking, skills, extensions, prompt
├── skills/<role>/SKILL.md        # the role's skill (instructions/persona)
│   skills/conductor/             # cross-project conductor
│   skills/project-lead/          # per-project lead (casts workers)
│   skills/implementation/ …      # worker skills
├── agents/<role>.md              # pi-subagents roster (spawnable children)
├── extensions/linear.ts          # narrow linear_* tools
├── extensions/e2b/               # E2B remote cast tools (project-lead only)
├── docs/e2b-v0.md                # E2B design + job contract
└── bin/pi-<role>                 # wrapper: hardcodes --tools, launches Pi via outfitter
```

---

## Adding a new profile

1. **Skill** — `skills/<role>/SKILL.md` (front-matter `name`/`description` + the role's instructions).
2. **Profile** — `profiles/<role>/profile.yml`:
   ```yaml
   id: <role>
   label: <Role label>
   controls:
     pi:
       provider: openai-codex        # or kimi-coding / openrouter / xai-auth
       model: gpt-5.5                 # per model-classifier / cost-arbitrage
       thinking: medium               # off|minimal|low|medium|high|xhigh
       skills:
         - /Users/<you>/code/pi-fleet/skills/<role>
       # extensions:                  # optional
       #   - /Users/<you>/code/pi-fleet/extensions/linear.ts
     append_system_prompt: |          # optional extra rules
       ...
   ```
3. **Wrapper** — `bin/pi-<role>` (copy an existing one, set the `--tools` allowlist):
   ```bash
   #!/usr/bin/env bash
   set -euo pipefail
   exec outfitter run --profile <role> --agent pi -- --tools read,grep,find,ls,... "$@"
   ```
   then `chmod +x bin/pi-<role>`.
4. **Verify + commit** — `outfitter profile list` should show it; `pi-<role> -p "..."` should run.
   `git add -A && git commit -m "add pi-<role>" && git push`.

The security boundary is the wrapper's `--tools` line — a read-only seat simply omits
`write`/`edit`/`bash`. Skills and prompts are instructions, not a boundary.

---

## Permissions (no click-ops on fleet seats)

Fleet seats should not stop for “Permission Required” dialogs. Policy lives in:

- Global: `permission-system/config.json` (bootstrapped into `~/.pi/agent/...`)
- Project: `.pi/extensions/pi-permission-system/config.json` (**yoloMode** + allow; denials for `.env` / ssh)
- Subagent frontmatter: `agents/project-lead.md`, `agents/conductor.md`

Details: [`docs/permissions.md`](./docs/permissions.md). **One project lead per project workspace.**

After pulling: `bin/pi-fleet-bootstrap`, then restart seats.

---

## E2B remote implementers (v0)

The **project lead** can cast an **implementer** into an [E2B](https://e2b.dev) sandbox instead of
a local worktree. Full design: [`docs/e2b-v0.md`](./docs/e2b-v0.md).

**Who:** only `pi-project-lead` (tools on its `--tools` allowlist).  
**What:** async `e2b_cast` → `jobId`; `e2b_status` / `e2b_wait` / `e2b_cancel` / `e2b_logs`.  
**Jobs:** `~/.pi/fleet/jobs/<jobId>.json` (local store; Convex later).

### One-time setup

1. **E2B account + API key**
   ```bash
   export E2B_API_KEY=e2b_...
   ```
2. **Install extension deps** (once per clone):
   ```bash
   (cd extensions/e2b && npm install)
   ```
3. **GitHub token for the sandbox** (short-lived / fine-grained PAT for v0):
   ```bash
   export FLEET_GITHUB_TOKEN=github_pat_...   # preferred
   # or: export GH_TOKEN=...
   ```
   Minimum scopes for private repos + PR open/push (fine-grained):
   - Repository access: the target repo(s) only
   - Permissions: **Contents** read/write, **Pull requests** read/write, **Metadata** read
   - Short expiration; rotate often. Do **not** use your unlimited classic PAT long-term.
   - Next evolution: GitHub App installation tokens per job (see design doc).
4. **Fleet-worker model keys** (separate from your personal CEO laptop keys when possible):
   ```bash
   export OPENAI_API_KEY=...          # or whichever providers the implementer will use
   export OPENROUTER_API_KEY=...
   # etc. — injected into the sandbox env; never logged by the extension
   ```
5. **Optional template** (hybrid bootstrap — preinstall pi, gh, git, Node 22):
   ```bash
   export FLEET_E2B_TEMPLATE=your-template-id
   export FLEET_REPO_URL=https://github.com/kellykampen/pi-fleet.git  # pin source
   ```

Without `E2B_API_KEY`, `e2b_cast` still works in **dry-run** mode (local job record only) so you can
exercise the project-lead flow offline.

### Example (from a project-lead session)

```
e2b_cast({
  profile: "implementer",
  codeAccess: "clone",
  repo: "owner/app",
  baseBranch: "main",
  ticketId: "ENG-123",
  brief: "Implement ENG-123 … AC: … open a draft PR …",
  timeoutMinutes: 90
})
# → jobId
e2b_status({ jobId })
e2b_wait({ jobId })   # optional
```
