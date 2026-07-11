# pi-fleet

**A fleet of restricted, single-purpose AI coding agents you launch from the terminal.**

pi-fleet turns the [Pi coding agent](https://pi.dev) into a set of reusable agent **"seats"** — each
one a role (implementer, reviewer, researcher, designer, …) with a *fixed* model, skill, and **tool
allowlist**. A reviewer seat literally has no `bash`/`write`/`edit`; a builder does — the restriction
is enforced, not just suggested. You compose the seats into a small org: a **conductor** routes work
to **project leads**, who **cast workers** into their own terminal panes — so you can run many agents
in parallel with real guardrails.

It **composes three upstream packages — nothing forked**:
[outfitter](https://pi.dev/packages/@ai-outfitter/outfitter) (loadout + CLI launch),
[`pi-subagents`](https://github.com/gotgenes/pi-subagents) (spawnable child agents), and
[`@gotgenes/pi-permission-system`](https://github.com/gotgenes/pi-packages) (per-tool **and**
per-bash-command allow · ask · deny). pi-fleet is the thin, versioned config + wrappers + skills on
top.

### Requirements

- [Pi](https://pi.dev) and [outfitter](https://pi.dev/packages/@ai-outfitter/outfitter) installed
- Global pi packages: `pi-mcp-adapter`, `pi-subagents`, `@gotgenes/pi-permission-system`
- At least one provider/model authenticated in Pi (e.g. `openai-codex`, `xai-auth`, `kimi-coding`, `openrouter`)
- *Optional*, for long-running `pi-conductor`/`pi-project-lead` seats that self-schedule checkups:
  `@jl1990/pi-scheduler` — see [docs/scheduling.md](docs/scheduling.md). **Avoid `pi-schedule-prompt`**;
  its full-screen overlay can get stuck and block input to the pane.

### Quick start

```bash
git clone https://github.com/YOUR_ORG/pi-fleet.git ~/code/pi-fleet && cd ~/code/pi-fleet
bin/pi-fleet-bootstrap                        # symlink config, install the permission template, apply patches
export PATH="$HOME/code/pi-fleet/bin:$PATH"   # add the wrappers to PATH (persist in ~/.zshrc)
cd ~/your/project && pi-reviewer              # launch a read-only reviewer seat
```

Models in the profiles are **defaults, not locks** — override per launch with `--provider/--model`,
or let the `pi-conductor`/`pi-project-lead` pick one via the bundled `model-classifier` skill.

## Hierarchy

Fixed vocabulary for every skill, agent, and cast:

```
CEO  →  conductor  →  project lead  →  worker
(you)   (portfolio)   (one project)    (implementer, reviewer, …)
```

| Seat | Command | Owns |
| --- | --- | --- |
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
| --- | --- | --- | --- |
| **`pi-implementer`** | GPT-5.6 Sol (`openai-codex`) · high | read, grep, find, ls, **write, edit, bash** + linear read | Builds one ticket end-to-end in a worktree (code + tests → PR). Override to Kimi `k2p7` for simple work. |
| **`pi-reviewer`** | Kimi K2.7 (`kimi-coding`) · medium | read, grep, find, ls + linear read *(no bash)* | Independent **read-only** code review/QC. Must run on a **different model** than the implementer. |
| **`pi-ac-verifier`** | Grok 4.5 (`xai-auth`) · high | read, grep, find, ls, **bash** + linear | **Runs** the acceptance-criteria verification (tests/build), checks the AC boxes only on real pass. Different model than the build. |
| **`pi-researcher`** | Kimi K2.7 · low | read, grep, find, ls | Read-only scouting / codebase investigation. |
| **`pi-designer`** | GPT-5.6 Terra (`openai-codex`) · high | read, grep, find, ls, write, edit, bash | Design / architecture / API + planning docs (taste model). Hands build to `pi-implementer`. For **claude.ai design import/update**, use `claude-designer` instead. |
| **`claude-designer`** | Claude Code (`--agent claude`) | `mcp__claude_design__*` + Read/Grep/Glob/Edit/Write/Bash(git,pnpm,npm) | Reads/updates **claude.ai design** projects via the `claude_design` MCP and implements them. Runs **Claude Code, not pi** — claude_design's OAuth is gated to Claude Code's blessed client (pi's generic MCP OAuth is turned down). One-time `/design-login` if tools 401. |
| **`pi-planner`** | GPT-5.6 Terra · high | read, grep, find, ls, bash + linear | Breaks a feature into a Linear project + ≤3-pt issues with checkbox AC + blockers. |
| **`pi-security-reviewer`** | Grok 4.5 (`openrouter`) · high | read, grep, find, ls *(read-only)* | Security-focused review — reports exploitable vulns with severity + file:line. |
| **`pi-conductor`** | GPT-5.5 · high | read, grep, find, ls, write, edit, bash + linear | Cross-project router — assigns **project leads**, watches portfolio health, escalates to the CEO. Does not cast workers. |
| **`claude-conductor`** | Claude Code (`--remote-control`) | *(no allowlist — same tool surface as `claude`)* | Thin wrapper that launches Claude Code with `--remote-control` so the CEO can reach the Conductor from the Claude Code **mobile app**. Every other Claude seat has `remoteControlAtStartup=false`; this is the one session that opts back in. Session name defaults to `claude-conductor`, override with `CONDUCTOR_NAME`. `FLEET_YOLO=1` gates `--dangerously-skip-permissions`, same convention as the other wrappers. |
| **`pi-project-lead`** | GPT-5.5 · high | read, grep, find, ls, write, edit, bash + linear | Owns one project — routes each task to the right worker + model (via **model-classifier**), casts seats, holds QC gates. |
| **`pi-visual-qa`** | Grok 4.5 (`xai-auth`) · high | read, grep, find, ls, **bash** *(+ image, playwright)* | **Captures** the app screenshot (playwright) and compares it to the design comp. Tears down anything it spawns. |
| **`pi-linear`** | Kimi K2.7 · low | read, grep, find, ls, **bash** + `linear_*` | Full Linear issue/project management (create, labels, relations, projects — via `linear-cli` + the `linear.ts` extension). |
| **`pi-personal-assistant`** | **GPT-5.6 Terra** (`openai-codex`) · medium | read, grep, find, ls, write, edit, bash + `linear_*` | The operator's **personal assistant** — social/X, comms, notes, tasks. Runs the CLIs below under a **draft → approval → execute** gate (nothing sends without an explicit per-item OK). |

The `pi-personal-assistant` toolkit (all via `bash`, documented in its skill):
`finch` (X) · `gog` (Google Workspace) · `imsg` (iMessage) · `wacli` (WhatsApp) ·
`obsidian-cli` (Obsidian) · `ntn` (Notion) · `linear-cli` · `gh`/`git`.

**Models are defaults, not locks.** Each profile's model is a sensible fallback so `pi-<role>` runs
standalone — but the **`pi-project-lead`** picks the model per task using the **model-classifier
skill** (loaded into it) and overrides via `--provider/--model` on the cast. So routing = "which
worker profile + which model," decided per task, not baked rigidly into the profile.

---

## Profile requirements (external CLIs)

Every seat needs the [global setup](#requirements) (pi + outfitter + the three packages). Beyond
that, individual profiles shell out to external CLIs — install the ones for the seats you use, and
make sure they're on `PATH`:

| Profile(s) | Needs on `PATH` (beyond global setup) |
| --- | --- |
| `pi-reviewer`, `pi-researcher`, `pi-security-reviewer` | *nothing* — read-only seats |
| `pi-implementer`, `pi-designer`, `pi-ac-verifier` | `git`, `gh`, and the target project's toolchain (`node` + `pnpm`/`npm`) |
| `pi-planner`, `pi-linear` | [`linear-cli`](https://github.com/schpet/linear-cli) *(+ a `LINEAR_API_KEY`)* |
| `pi-visual-qa` | `node` + Playwright (`npx playwright install`); a way to run the app under test |
| `pi-conductor`, `pi-project-lead` | [`cmux`](https://cmux.io) (casts workers into panes), `git`, `gh`, `linear-cli` |
| `pi-project-lead` **E2B remote casts** | the `e2b` CLI (`npm i` in `extensions/e2b`) + `E2B_API_KEY` + `FLEET_GITHUB_TOKEN` — see [E2B section](#e2b-remote-implementers-v0) |
| `pi-remotion` | `node`/`npm` + [Remotion](https://www.remotion.dev) (`npx remotion`) |
| `pi-personal-assistant` | your own CLIs on `PATH`: `finch` (X), `gog` (Google), `imsg` (iMessage), `wacli` (WhatsApp), `obsidian-cli`, `ntn` (Notion), `linear-cli`, `gh`/`git`. **Not bundled** — supply your own; the profile only orchestrates them under a draft→approve→execute gate. |
| `claude-designer`, `claude-reviewer`, `claude-worker`, `claude-conductor` | [Claude Code](https://claude.com/claude-code) (`claude`), authenticated. `claude-designer` also needs a one-time `/design-login`. |
| `agy-researcher`, `agy-reviewer`, `agy-worker` | the `agy` CLI (Antigravity/Gemini), authenticated. |

Read-only seats (`pi-reviewer` etc.) deliberately have **no `bash`**, so they need nothing extra.
A seat whose CLI is missing will simply fail that command — install it and re-run.

---

## Two ways to run a role: top-level seat vs. spawnable subagent

pi-fleet composes **three upstream packages** — nothing is forked:

| Layer | Package | Role |
| --- | --- | --- |
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
  - path: ~/code/pi-fleet/profiles
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
├── docs/e2b-v0.md                # E2B pointer to Linear
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
         - ../skills/<role>
       # extensions:                  # optional
       #   - ../extensions/linear.ts
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

## Personal Pi global prompt schedules

`pi-personal-assistant` recreates two global prompt schedules (`social-x-checkup`,
`gmail-reply-checkup`) on every start/restart via macOS launchd — idempotent, local (needs local
`finch`/`gog` CLI + auth access, so it can't be a cloud scheduler). Source of truth:
[`profiles/personal-assistant/schedules.json`](./profiles/personal-assistant/schedules.json).
Details: [`docs/personal-schedules.md`](./docs/personal-schedules.md).

---

## E2B remote implementers (v0)

The **project lead** can cast an **implementer** into an [E2B](https://e2b.dev) sandbox instead of
a local worktree. Planning and design live in Linear: E2B remote workers v0 project (see docs/e2b-v0.md) · E2B v0 design doc (see docs/e2b-v0.md).

**Who:** only `pi-project-lead` (tools on its `--tools` allowlist).  
**What:** async `e2b_cast` → `jobId`; `e2b_status` / `e2b_wait` / `e2b_cancel` / `e2b_logs`.  
**Jobs:** `~/.pi/fleet/jobs/<jobId>.json` (local store; Convex later).

### One-time setup

Required environment variables for non-dry-run casts:

- `E2B_API_KEY` — creates/connects the sandbox.
- `FLEET_GITHUB_TOKEN` (preferred) or `GH_TOKEN` — injected into the sandbox for clone/push/PR operations.
- One or more fleet-worker model keys for the selected provider, for example `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`, `XAI_API_KEY`, `GEMINI_API_KEY`, `GOOGLE_API_KEY`, `KIMI_API_KEY`, or `MOONSHOT_API_KEY`.

1. **E2B account + API key**

   ```bash
   export E2B_API_KEY=e2b_...
   ```

2. **Install extension deps** (once per clone; includes the package-local E2B CLI):

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
   - Short expiration; rotate/revoke after each cast or work batch when possible. Do **not** use your unlimited classic PAT long-term.
   - Next evolution: GitHub App installation tokens per job (see design doc).
4. **Fleet-worker model keys** (separate from your personal CEO laptop keys when possible):

   ```bash
   export OPENAI_API_KEY=...          # or whichever providers the implementer will use
   export OPENROUTER_API_KEY=...
   # etc. — injected into the sandbox env; never logged by the extension
   ```

5. **E2B template** (recommended hybrid bootstrap — preinstalls Node 22, git, gh, pi, outfitter):

   ```bash
   (cd extensions/e2b && npm run template:verify)        # local/static validation

   export E2B_API_KEY=e2b_...
   (cd extensions/e2b && npm run template:publish -- pi-fleet-node22)

   export FLEET_E2B_TEMPLATE=pi-fleet-node22             # template id/name from publish
   export FLEET_REPO_URL=https://github.com/YOUR_ORG/YOUR_REPO.git  # pin source
   ```

   Smoke a published template:

   ```bash
   cd extensions/e2b
   node --input-type=module <<'EOF'
   import { Sandbox } from 'e2b';

   const template = process.env.FLEET_E2B_TEMPLATE;
   const apiKey = process.env.E2B_API_KEY;
   if (!template || !apiKey) throw new Error('Set FLEET_E2B_TEMPLATE and E2B_API_KEY');

   const sbx = await Sandbox.create(template, { apiKey, timeoutMs: 300_000 });
   let exitCode = 0;
   try {
     const result = await sbx.commands.run('bash -lc "pi --version && gh --version"', { timeoutMs: 120_000 });
     if (result.stdout) process.stdout.write(result.stdout);
     if (result.stderr) process.stderr.write(result.stderr);
     if (typeof result.exitCode === 'number') exitCode = result.exitCode;
   } finally {
     await sbx.kill();
   }
   process.exitCode = exitCode;
   EOF
   ```

   Record the published `FLEET_E2B_TEMPLATE` value as a comment on Linear issue FLT-1.

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
