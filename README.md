# pi-fleet

**A fleet of restricted, single-purpose AI coding agents you launch from the terminal.**

pi-fleet turns the [Pi coding agent](https://pi.dev) into a set of reusable agent **"seats"** — each
one a role (implementer, reviewer, researcher, designer, …) with a documented default model, skill, and **tool
allowlist**. A reviewer seat literally has no `bash`/`write`/`edit`; a builder does — the restriction
is enforced, not just suggested. You compose the seats into a small org: a **conductor** routes work
to **project leads**, who **cast workers** into their own terminal panes — so you can run many agents
in parallel with real guardrails.

It **composes two upstream packages — nothing forked**:
[outfitter](https://pi.dev/packages/@ai-outfitter/outfitter) (loadout + CLI launch) and
[`pi-subagents`](https://github.com/gotgenes/pi-subagents) (spawnable child agents).
`@gotgenes/pi-permission-system` is **not** used (removed FLT-67 — always YOLO; security is
wrapper `--tools` + command-policy extensions). pi-fleet is the thin, versioned config + wrappers
+ skills on top.

## Requirements

- [Pi](https://pi.dev) and [outfitter](https://pi.dev/packages/@ai-outfitter/outfitter) installed
- Node.js 20+ and global pi packages: `pi-mcp-adapter`, `pi-subagents` (do **not** install `@gotgenes/pi-permission-system` — removed FLT-67)
- Repo-local tools installed by `setup.sh`, including exact-pinned `agent-interview-cli@0.1.0`
- At least one allowed provider/model authenticated in Pi (`openai-codex` with `gpt-5.5`/`gpt-5.6` is the default, but new worker casts currently require explicit CEO/conductor approval due to the GPT usage guard — see [`docs/model-overrides.md`](docs/model-overrides.md))
- *Optional*, for long-running `pi-conductor`/`pi-project-lead` seats that self-schedule checkups:
  `@jl1990/pi-scheduler` — see [docs/scheduling.md](docs/scheduling.md). **Avoid `pi-schedule-prompt`**;
  its full-screen overlay can get stuck and block input to the pane.

### Quick start

```bash
git clone https://github.com/YOUR_ORG/pi-fleet.git ~/code/pi-fleet && cd ~/code/pi-fleet
./setup.sh                                    # check + install deps, wire config, guide auth
export PATH="$HOME/code/pi-fleet/bin:$PATH"   # add the wrappers to PATH (persist in ~/.zshrc)
cd ~/your/project && pi-reviewer              # launch a read-only reviewer seat
```

`setup.sh` is the one-copy onboarding entry point: it checks (and, on macOS with Homebrew, offers
to install) the quick-start dependencies below, runs `bin/pi-fleet-bootstrap` to wire local config
(idempotent — it backs up, never overwrites, any pre-existing config), and guides you through
external-service auth (`gh`, Linear, a Pi provider, optional E2B). It installs the spike interview
runtime clone-locally from its integrity-locked npm dependency with install scripts disabled. Run
`./setup.sh --check` for a side-effect-free status report, or `./setup.sh --yes` to auto-confirm
every install it knows how to do. See `./setup.sh --help` for details.

Models in the profiles are **defaults, not locks** — override per launch with `--provider/--model`,
or let the `pi-conductor`/`pi-project-lead` pick one via the bundled `model-classifier` skill.

> **Active GPT usage guard (FLT-55):** new `pi-*` worker/reviewer/AC-verifier/QA casts must not
> use `openai-codex` / GPT without explicit CEO/conductor approval while the guard is active.
> Preferred non-GPT alternatives: `--provider xai-auth --model grok-4.5-latest` and
> `--provider kimi-coding --model k/3`. See [`docs/model-overrides.md`](docs/model-overrides.md)
> for the full override guidance.

Pi-fleet runtime data lives only under private `~/.pi-fleet` (or an absolute `PI_FLEET_HOME`).
See the canonical [runtime-state contract](docs/runtime-state.md). Bootstrap creates/repairs this
root but never silently migrates old data; use `bin/pi-fleet-state-migrate` to report first.

**Agent mail:** seats exchange structured async status via `fleet-mail` (not cmux send drip).
Workers mail the owning project lead only; leads **pull** the inbox on idle/cadence (no mid-turn
status steers) and post compact rollups to the conductor. Same CLI for Pi, Claude Code, and Codex.
See [`docs/agent-mail.md`](docs/agent-mail.md), multi-harness notes
[`docs/codex-fleet-mail.md`](docs/codex-fleet-mail.md),
[`docs/batch-append-messaging.md`](docs/batch-append-messaging.md), and the pi-messenger decision
[`docs/pi-messenger-decision.md`](docs/pi-messenger-decision.md).

## Hierarchy

Fixed vocabulary for every skill, agent, and cast:

```
CEO  →  conductor  →  project lead  →  worker
(you)   (portfolio)   (one project)    (implementer, reviewer, …)
```

| Seat | Command | Owns |
| --- | --- | --- |
| **CEO** | (human) | Goals, priorities/reprioritization, risk/money |
| **Conductor** | `pi-conductor` | Cross-project routing; assigns project leads; escalates CEO decisions |
| **Project lead** | `pi-project-lead` | One project/stream; casts workers; holds every gate; merges to main only when the CEO orders |
| **Worker** | `pi-implementer`, `pi-reviewer`, … | Single-purpose work; reports to the project lead |

**Cast** = spin up a worker seat (project lead → worker). The conductor assigns work to project
leads; it does not cast workers directly.

**Communication topology (FLT-57):** allowed edges only — worker/reviewer/AC ↔ project lead;
project lead ↔ conductor/coordinator; conductor ↔ CEO/cross-project. Workers never message
conductor/CEO; conductor never messages workers; no drip-feed status or pane-tail spam. Leads send
one compressed `STATUS t= / PRs: #N CI= AC= block= / agents: … / need: …` rollup every 5–10 min or
on real state change.

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
pi-<role>  ==  outfitter run --profile <role> --agent pi  --  [env model args] --tools <allowlist>  "$@"
```

---

## The profiles

| Command | Model (default) | Tools | What it does |
| --- | --- | --- | --- |
| **`pi-implementer`** | GPT-5.6 Sol (`openai-codex`) · high | read, grep, find, ls, **write, edit, bash** + linear read | Builds one ticket end-to-end in a worktree (code + tests → PR). Strong coding default; override to `gpt-5.5` for simple work. |
| **`pi-reviewer`** | GPT-5.5 (`openai-codex`) · medium | read, grep, find, ls + linear read *(no bash)* | Independent **read-only** code review/QC. Must run on a **different model** than the implementer. |
| **`pi-ac-verifier`** | GPT-5.5 (`openai-codex`) · high | read, grep, find, ls, **bash**, **subagent** + linear + `github_pr_comment` | **Runs** dual-source AC verification (Linear checkbox AC + PR body AC/checklist) against the PR's actual head commit by fanning out one verify-only `ac-criterion-verifier` subagent per criterion via pi-subagents, synthesizing PASS/FAIL + evidence, posting PR + Linear evidence itself, and checking boxes only on real pass. Fails if validation dirties the worktree. No write/edit tools, no pushes, no PR mutation beyond comments; never implementer/lead/code-writer for that PR. |
| **`pi-researcher`** | GPT-5.5 (`openai-codex`) · low | read, grep, find, ls | Read-only scouting / codebase investigation. |
| **`pi-designer`** | GPT-5.6 Terra (`openai-codex`) · high | read, grep, find, ls, write, edit, bash | Design / architecture / API + planning docs (taste model). Hands build to `pi-implementer`. For **claude.ai design import/update**, use `claude-designer` instead. |
| **`claude-designer`** | Claude Code (`--agent claude`) | `mcp__claude_design__*` + Read/Grep/Glob/Edit/Write/Bash(git,pnpm,npm) | Reads/updates **claude.ai design** projects via the `claude_design` MCP and implements them. Runs **Claude Code, not pi** — claude_design's OAuth is gated to Claude Code's blessed client (pi's generic MCP OAuth is turned down). One-time `/design-login` if tools 401. |
| **`pi-planner`** | GPT-5.6 Terra · high | read, grep, find, ls, bash + linear | Breaks a feature into a Linear project + ≤3-pt issues with checkbox AC + blockers. |
| **`pi-spike-breakdown`** | GPT-5.6 Terra · high | read, grep, find, ls, bash + linear | Turns a Linear **spike** into a Linear project + ≤3-pt issues. Its primary interview channel is pinned `agent-interview-cli` opening a direct browser form. Stable decisions and exact answers are persisted and posted to the source spike before decomposition; cancellation/timeout/non-interactive fallback fails loudly. See [spike interviews](docs/spike-interviews.md). Reads Linear + repo; no repo `write`/`edit`. |
| **`pi-security-reviewer`** | GPT-5.6 Sol (`openai-codex`) · high | read, grep, find, ls *(read-only)* | Security-focused review — reports exploitable vulns with severity + file:line. Strong reasoning default. |
| **`pi-conductor`** | GPT-5.5 · high | allowlisted **bash** + linear *(no read/grep/find/ls/write/edit)* | Portfolio router only (FLT-65): talks to project leads via cmux/Linear/`fleet-mail`; portfolio metadata (`gh pr list`/`checks`, `git status`/`log`/`branch`) allowed. Cannot read product PR diffs, `gh pr view`, `gh api` patch content, investigate tickets in-repo, clone, build, or mutate source. |
| **`claude-conductor`** | Claude Code (`--remote-control`) | conductor-only Bash allowlist *(no Read/Grep/Glob/Write/Edit)* | CEO-facing conductor with an authoritative fail-closed `PreToolUse` hook (same FLT-65 routing-only boundary). No merge-flow; `FLEET_YOLO` cannot bypass. |
| **`claude-project-lead`** | Claude Code (Opus by default) | Read/Grep/Glob + lead Bash allowlist *(no Write/Edit)* | Native project lead: orchestration plus narrow main integration (`fetch`, ff-only pull, checkout/switch main, merge/push, PR merge/comment, and worktree lifecycle). Build/install/script commands remain blocked. |
| **`pi-project-lead`** | GPT-5.5 · high | read, grep, find, ls, allowlisted **bash** + linear + e2b *(no write/edit)* | Owns one project as a coordination-only router/multiplier (non-bottleneck: cast immediately, parallel seats, poll 2–5m; never implement/light-fix) — casts every implementation/review/AC/docs seat (via **model-classifier**), holds QC gates, reports compressed rollups / merge-ready; merges to main only when the CEO orders. Harness-enforced: no source mutation or implementation shell. |
| **`pi-visual-qa`** | GPT-5.6 Terra (`openai-codex`) · medium | read, grep, find, ls, **bash** *(+ image, playwright)* | **Captures** the app screenshot (playwright) and compares it to the design comp. Tears down anything it spawns. Taste/visual default. |
| **`pi-linear`** | GPT-5.5 (`openai-codex`) · low | read, grep, find, ls, **bash** + `linear_*` | Full Linear issue/project management (create, labels, relations, projects — via `linear-cli` + the `linear.ts` extension). |
| **`pi-personal-assistant`** | **GPT-5.6 Terra** (`openai-codex`) · medium | read, grep, find, ls, write, edit, bash + `linear_*` | The operator's **personal assistant** — social/X, comms, notes, tasks. Runs the CLIs below under a **draft → approval → execute** gate (nothing sends without an explicit per-item OK). |
| **`pi-docs`** | GPT-5.5 (`openai-codex`) · medium | read, grep, find, ls, **write, edit, bash** + linear | **Final Docs-as-DoD gate** — runs after review + AC-verify + CI are green, before merge/Done. Reads the PR diff, updates README/docs to match, or states an explicit no-docs-needed rationale. Does not re-review code or AC. |

The `pi-personal-assistant` toolkit (all via `bash`, documented in its skill):
`finch` (X) · `gog` (Google Workspace) · `imsg` (iMessage) · `wacli` (WhatsApp) ·
`obsidian-cli` (Obsidian) · `ntn` (Notion) · `linear-cli` · `gh`/`git`.

**Models are defaults, not locks.** Each profile's model is a sensible fallback so `pi-<role>` runs
standalone — but the **`pi-project-lead`** picks the model per task using the **model-classifier
skill** (loaded into it) and overrides via `--provider/--model` on the cast. So routing = "which
worker profile + which model," decided per task, not baked rigidly into the profile.

### Model/provider override precedence

All `pi-*` wrappers merge model flags before launching Pi through outfitter. Precedence is:

1. Explicit wrapper CLI flags: `--provider ...` / `--model ...` (or `--provider=...` / `--model=...`)
2. Role env: `PI_<ROLE>_PROVIDER` / `PI_<ROLE>_MODEL` (uppercase role; hyphens become underscores)
3. Role aliases where defined, e.g. `PI_LEAD_PROVIDER` / `PI_LEAD_MODEL` for `pi-project-lead`
4. Generic env: `PI_PROVIDER` / `PI_MODEL`
5. The documented `profiles/<role>/profile.yml` default

Examples:

```bash
PI_MODEL=gpt-5.5 pi-reviewer -p "review PR #123"
PI_IMPLEMENTER_PROVIDER=openai-codex PI_IMPLEMENTER_MODEL=gpt-5.6-sol pi-implementer
PI_LEAD_MODEL=gpt-5.6-luna pi-project-lead
PI_MODEL=gpt-5.5 pi-reviewer --model gpt-5.6-sol  # explicit CLI wins
```

The deterministic guard is `bin/pi-fleet-eval-model-overrides`; it mocks `outfitter` and verifies
role env, generic env, aliases, and explicit CLI precedence without starting an interactive session.

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
| `pi-spike-breakdown` | `linear-cli` plus the repo-local `agent-interview-cli@0.1.0` installed by `setup.sh`; see [install, schema, fallback, and audit contract](docs/spike-interviews.md) |
| `pi-visual-qa` | `node` + Playwright (`npx playwright install`); a way to run the app under test |
| `pi-conductor`, `pi-project-lead` | [`cmux`](https://cmux.io) (casts workers into panes), `git`, `gh`, `linear-cli` |
| `pi-project-lead` **E2B remote casts** | the `e2b` CLI (`npm i` in `extensions/e2b`) + `E2B_API_KEY` + a GitHub App (recommended) or `FLEET_GITHUB_TOKEN` — see [E2B section](#e2b-remote-implementers-v0) |
| `pi-remotion` | `node`/`npm` + [Remotion](https://www.remotion.dev) (`npx remotion`) |
| `pi-personal-assistant` | your own CLIs on `PATH`: `finch` (X), `gog` (Google), `imsg` (iMessage), `wacli` (WhatsApp), `obsidian-cli`, `ntn` (Notion), `linear-cli`, `gh`/`git`. **Not bundled** — supply your own; the profile only orchestrates them under a draft→approve→execute gate. |
| `pi-docs` | `git`, `gh` (to read the PR diff) |
| `claude-designer`, `claude-reviewer`, `claude-worker`, `claude-conductor`, `claude-project-lead` | [Claude Code](https://claude.com/claude-code) (`claude`), authenticated. `claude-designer` also needs a one-time `/design-login`. |
| `agy-researcher`, `agy-reviewer`, `agy-worker` | Disabled by roster lock; use `claude-*` or `pi-*` seats instead. |

Read-only seats (`pi-reviewer` etc.) deliberately have **no `bash`**, so they need nothing extra.
A seat whose CLI is missing will simply fail that command — install it and re-run.

---

## Two ways to run a role: top-level seat vs. spawnable subagent

pi-fleet composes **two upstream packages** — nothing is forked:

| Layer | Package | Role |
| --- | --- | --- |
| Loadout + CLI launch | **outfitter** | Composes model/skills/extensions/system-prompt into a profile; the `bin/pi-<role>` wrapper launches it and hardcodes the `--tools` allowlist. |
| Spawnable subagents | **pi-subagents** | Lets a running seat *delegate* to a child agent (chains, parallel, background). Roster lives in `agents/*.md`. |
| Runtime policy | **wrapper `--tools` + command-policy extensions** | Always YOLO (`--approve`). No `@gotgenes/pi-permission-system`. Security = per-seat `--tools` allowlists + `conductor-policy` / `project-lead-policy` / `ac-verifier-policy` (+ hard secret denies). |

So each role exists in two forms:

- **Top-level seat** — `bin/pi-<role>` (outfitter + `--tools`). Start it yourself from a terminal.
- **Spawnable subagent** — `agents/<role>.md`, discovered globally at `~/.pi/agent/agents/`. Any seat
  (typically `pi-project-lead`) delegates to it via the `subagent` tool. Its `tools:` frontmatter is
  the visibility allowlist (there is no `permission:` frontmatter after FLT-67). Read-only roles
  (`reviewer`, `researcher`, `security-reviewer`) carry no `bash`/`write`/`edit` **by construction**.

### Machine setup + durability

```bash
bin/pi-fleet-bootstrap        # symlink mcp.json, agents/ into ~/.pi; re-apply patches (no permission-system)
bin/pi-fleet-repair           # idempotently re-apply the outfitter + pi-tui patches (run after any update)
bin/pi-fleet-eval             # prove each seat's --tools allowlist really enforces read/write/bash
bin/pi-fleet-eval-banned-terms # REQUIRED pre-merge gate: no other project's name/prefix in pi-fleet
```

Two patches (auto-reverted by `outfitter update` / `pi update`, so `pi-fleet-repair` re-applies them):

1. **outfitter** — persist `pi-mcp-adapter`'s OAuth/onboarding state (else it's wiped each launch).
2. **pi-tui** — truncate overflowing lines instead of crashing pi (narrow panes overflow the banner).

Required global pi packages: `pi-mcp-adapter`, `pi-subagents`. Do **not** install `@gotgenes/pi-permission-system` (removed FLT-67).

---

## How to start a profile

The wrappers live in `bin/` and are on your `$PATH` (see setup below). From any terminal:

```bash
# cd to where you want the agent to work, then run the wrapper:
cd ~/code/tiny-projects/kellyk-dev && pi-personal-assistant

# any extra args forward straight to Pi:
pi-reviewer --provider openai-codex --model gpt-5.6-luna  # override the model for this run
pi-personal-assistant -p "draft a reply to my latest mention"   # one-shot, non-interactive
```

Supporting commands:

```bash
outfitter profile list                                  # list all profiles
outfitter run --profile personal-assistant --agent pi   # raw launch (SKIPS --tools enforcement — prefer the wrapper)
```

### Running the Docs pass on a PR

A project lead invokes `pi-docs` as the **last** gate, once review + AC-verify + CI are already
green, right before merge/Done:

```bash
cd <worktree-or-repo> && pi-docs -p "Docs pass for PR #<N> — read the diff, update README/docs to match, or state why none are needed."
```

It reports either the exact docs files it changed, or an explicit no-docs-needed rationale —
post that as the PR's Docs-pass evidence before merging.

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
       provider: openai-codex        # allowed pi default provider
       model: gpt-5.5                 # documented fallback; override at launch when needed
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
   DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
   . "$DIR/lib/pi-model-env.sh"
   . "$DIR/lib/pi-wrapper-args.sh"
   pi_model_override_args <role> "" "$@"
   pi_sanitize_passthrough_args "$@"
   exec outfitter run --profile <role> --agent pi -- ${PI_MODEL_ARGS[@]+"${PI_MODEL_ARGS[@]}"} ${PI_PASSTHROUGH_ARGS[@]+"${PI_PASSTHROUGH_ARGS[@]}"} --approve --tools read,grep,find,ls,...
   ```

   then `chmod +x bin/pi-<role>`.
4. **Verify + commit** — `outfitter profile list` should show it; `pi-<role> -p "..."` should run.
   `git add -A && git commit -m "add pi-<role>" && git push`.

The security boundary is the wrapper's `--tools` line — a read-only seat simply omits
`write`/`edit`/`bash`. Skills and prompts are instructions, not a boundary.

---

## Permissions (no click-ops on fleet seats)

Fleet seats must never stop for “Permission Required” dialogs. **Always YOLO (FLT-67):** every Pi
wrapper passes `--approve`; `@gotgenes/pi-permission-system` is fully removed. Security is the
wrapper `--tools` allowlist plus immutable command-policy extensions where bash is restricted.

`pi-conductor` and `pi-project-lead` are stricter: no `write`/`edit`, always `--approve`, and
immutable `conductor-policy.ts` / `project-lead-policy.ts` bash gates (shared evaluator
`bin/lib/conductor-command-policy.mjs`). Conductor is routing-only (FLT-65): bash + Linear tools
only — no product-repo investigation tools. Isolated agent overlay + policy cwd keep coordination
root as `FLEET_COORDINATION_ROOT` / `launch-cwd/` — not for a permission-system package.
Project-lead keeps coordination + narrow main-integration power and loses product-implementation
power (no commit/build/install/script shell). Claude conductor/lead wrappers load separate
`claude-settings/*.json` files; their seat-specific `PreToolUse` hook is authoritative and fails
closed on unknown or compound commands.

**Unattended fleet seats (FLT-60 + FLT-66 + FLT-67):** every primary Pi seat always passes
`--approve` (not gated on `FLEET_YOLO`). `@gotgenes/pi-permission-system` is **fully removed** —
no seat loads it. Security = wrapper `--tools` allowlist + command-policy extensions where bash
is restricted (`conductor-policy` / `project-lead-policy` / `ac-verifier-policy`). Implementer keeps
write/edit/bash under `--no-extensions` + explicit linear; FTD/E2B casts inherit unattended argv.

Details: [`docs/permissions.md`](./docs/permissions.md). **One project lead per project workspace.**

After pulling: `bin/pi-fleet-bootstrap` if needed, then **restart every fleet seat** (lead, conductor,
implementer panes, FTD casts) so wrappers pick up the new argv.

---

## Model usage cadence, roster overrides, and the machine-load guard

The conductor and project-lead skills each carry the same standing policy for: running
`check-model-usage` on a ~30-minute cadence and acting on OVER_PACE/EXHAUSTED; declaring and
time-boxing temporary roster overrides (e.g. an Opus-only window); and serializing local
build/test/typecheck/dev-server/e2e steps against a machine-load threshold (hold new heavy steps
above ~28, resume serialized once drained). See `skills/conductor/SKILL.md` and
`skills/project-lead/SKILL.md`, section "Model usage, roster overrides, and the machine-load
guard" in each.

## Standing fleet directives (delegation, DoD, roster lock, hygiene)

`skills/conductor/SKILL.md` and `skills/project-lead/SKILL.md` also codify: the conductor's
"does no work" delegation-only rule + routing table; the two-conductor model
(`claude-conductor` = CEO-facing relay, `pi-conductor` = drives project leads); the
**Docs-as-final-DoD-gate** canonical pipeline (short-lived ticket branch/worktree → review →
AC-verify → visual-QA where applicable → CI → Docs pass → project-lead reports merge-ready → merge to main only when the CEO orders → Done,
see the [`pi-docs`](#the-profiles) profile); the hard roster lock (allowed:
`claude-worker`/`claude-reviewer` Sonnet 5/Opus 4.8, `pi` `gpt-5.5`/`gpt-5.6`; banned: Grok/xAI,
Kimi/`claudekimi`, GLM/`claudeglm`, Gemini/`agy`); pane/seat hygiene (no mass-close, project
leads own their own workspace's seats); the Linear-first rule (ticket + checkbox AC before work
starts); project separation (no project carries another project's profile/skill-specific
wiring); and the meta-rule that every *new* standing rule gets codified here too, not left in a
conductor's private memory. See each skill file's matching sections for the full statements.

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
**Jobs:** `~/.pi-fleet/state/e2b/jobs/<jobId>.json` (private local fallback; Convex when configured).

### One-time setup

Required environment variables for non-dry-run casts:

- `E2B_API_KEY` — creates/connects the sandbox.
- A GitHub credential source for push/PR operations — **either** a GitHub App
  (recommended, FLT-6; see [step 3](#e2b-remote-implementers-v0) below) **or**
  `FLEET_GITHUB_TOKEN`/`GH_TOKEN` (legacy PAT fallback). Whichever source is
  active is injected into the sandbox (and, for `codeAccess: "pr"`/`"branch"`,
  used for the sandbox's own `gh repo clone` too — see
  [codeAccess](#e2b-remote-implementers-v0) above; `codeAccess: "clone"` needs
  no read scope for that step). Its repository scope is the access boundary
  for each cast's `repo`; pi-fleet does not maintain an approved-repository
  allowlist.
- One or more fleet-worker model keys for the selected allowed provider, typically `OPENAI_API_KEY` for openai-codex-backed workers.

1. **E2B account + API key**

   ```bash
   export E2B_API_KEY=e2b_...
   ```

2. **Install extension deps** (once per clone; includes the package-local E2B CLI):

   ```bash
   (cd extensions/e2b && npm install)
   ```

3. **GitHub credential for the sandbox** — a GitHub App is the recommended source
   (FLT-6): every non-dry-run cast mints a fresh, short-lived installation access
   token and injects only that token into the sandbox — the App's private key never
   leaves the `pi-project-lead` host process, and the sandbox never sees a
   long-lived personal token. A fine-grained PAT remains supported as a fallback
   for setups that haven't configured an App yet.

   **Option A — GitHub App (recommended)**

   1. Create a GitHub App (GitHub → Settings → Developer settings → GitHub Apps →
      New GitHub App). Repository permissions:
      - **Contents**: Read and write
      - **Pull requests**: Read and write
      - **Metadata**: Read-only (implied)
      (Same floor as the PAT below — GitHub's fine-grained model only offers Contents
      as a combined read/write tier, so this is required even for `codeAccess: "clone"`,
      where the sandbox itself never reads with this token; it's still needed for the
      push/PR step every codeAccess mode ends with.)
   2. Generate a private key for the App (Settings → General → "Generate a private
      key") and download the `.pem` file.
   3. Install the App on the target repo(s) (or org, scoped to specific repos) and
      note the **installation ID** (visible in the installation's settings URL:
      `.../settings/installations/<installation_id>`) and the App's **App ID**
      (shown on the App's settings page).
   4. Set:

      ```bash
      export FLEET_GITHUB_APP_ID=123456
      export FLEET_GITHUB_APP_INSTALLATION_ID=987654
      export FLEET_GITHUB_APP_PRIVATE_KEY_PATH=/path/to/app-private-key.pem
      # or, to inline the PEM instead of a file path:
      # export FLEET_GITHUB_APP_PRIVATE_KEY="$(cat /path/to/app-private-key.pem)"
      ```

      All three of `FLEET_GITHUB_APP_ID`, `FLEET_GITHUB_APP_INSTALLATION_ID`, and
      `FLEET_GITHUB_APP_PRIVATE_KEY`/`FLEET_GITHUB_APP_PRIVATE_KEY_PATH` must be set
      together — the fleet fails fast with a clear error before creating any
      sandbox if the App is only partially configured (it never silently falls
      back to a PAT in that case, since that would mask a broken setup).

   **Option B — fine-grained PAT (fallback, used only when no App env vars are set)**

   ```bash
   export FLEET_GITHUB_TOKEN=github_pat_...   # preferred
   # or: export GH_TOKEN=...
   ```

   Minimum scopes for private repos + PR open/push (fine-grained):
   - Repository access: the target repo(s) only
   - Permissions: **Contents** read/write, **Pull requests** read/write, **Metadata** read
   - Short expiration; rotate/revoke after each cast or work batch when possible. Do **not** use your unlimited classic PAT long-term.

   **Security notes:**
   - The App's private key is read from disk (or env) once per process and used
     only to sign a short-lived JWT locally; it is never sent to GitHub, never
     written into the sandbox, and never logged (it's included in the
     extension's secret-redaction list alongside every token type).
   - Installation tokens minted from the App (`ghs_...`) are further narrowed to
     just the cast's own `repo` (FLT-12) — even when the installation itself has
     access to many repos (an org-wide or multi-repo install), a given cast's
     token can only ever reach the one repo it's actually working on. They also
     expire on GitHub's own schedule (about an hour); one is minted fresh per
     cast rather than reused across jobs.
   - When both an App and a PAT are configured, the App always takes precedence —
     the sandbox never receives the PAT in that case.
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
   export FLEET_REPO_URL=https://github.com/YOUR_ORG/pi-fleet.git   # pi-fleet wrappers/profiles only
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

`FLEET_REPO_URL` is infrastructure configuration: it is cloned to `/work/pi-fleet` for the fleet
wrappers and profiles. It does **not** select the target repository; every cast's `repo` parameter
lands at `/work/repo`, but *how* it gets there depends on `codeAccess`:

- **`codeAccess: "pr"` / `"branch"`** — the sandbox itself runs `gh repo clone` against the target
  (then `gh pr checkout <n>` or `git fetch`+`checkout <branch>`), so access is determined solely by
  the scope of `FLEET_GITHUB_TOKEN`/`GH_TOKEN` injected into the sandbox. If that clone fails, the
  job becomes `failed` with a sanitized error explaining that the token may lack access (without
  persisting the token or raw authenticated URL).
- **`codeAccess: "clone"`** — the sandbox never clones the target itself, so it needs **no git
  read credentials at all** for this step (FLT-9). Instead, the host (the `pi-project-lead` process,
  which is already running from a local checkout of the target repo) resolves a local Git commit
  and packages only that commit's tracked content with `git archive <commit>`. It fails closed
  rather than packaging the working tree when Git, the checkout, or the requested ref is
  unavailable; ignored and untracked files are never uploaded. The resulting gzip tarball reaches
  the sandbox *before* the runner starts. The runner unpacks it into `/work/repo`, `git init`s a
  fresh repo from the extracted tree, adds the target as its `origin` remote, and commits that
  snapshot as a baseline before checking out the new working branch. The sandbox-side repo starts
  from a single fresh commit — full source history from the host's local checkout is not carried
  over, only tracked content at the resolved ref. `baseBranch`, when given, selects which local ref
  to archive (default: `HEAD`, i.e. whatever the host currently has checked out); it must already
  exist locally, since nothing is fetched.
  The resolved GitHub credential (a minted App installation token when configured, otherwise
  `FLEET_GITHUB_TOKEN`/`GH_TOKEN`) is still injected and used exactly as before for the later
  push/PR step (via `gh pr create` and the same `insteadOf` URL rewrite) — only the initial
  read/population step changes.

Without `E2B_API_KEY`, `e2b_cast` still works in **dry-run** mode (local job record only) so you can
exercise the project-lead flow offline.

### Casting against any repo (FLT-12)

`e2b_cast`'s `repo` parameter is per-cast and required — there is no fleet-wide default target repo,
and it always overrides whatever repo a previous cast used. `FLEET_REPO_URL` never changes: it is
always the pi-fleet tooling repo (cloned to `/work/pi-fleet` for wrappers/profiles), completely
independent of which repo a given cast's `repo` names.

To add a new repo to the set the fleet can actually reach:

- **A GitHub App installation is scoped to exactly one GitHub account (one user or one org).** It can
  only ever mint tokens for repos that live under that same account and are explicitly reachable by
  that installation — there is **no cross-installation or cross-org support**: a repo owned by a
  different account needs either a *separate* App installation (its own
  `FLEET_GITHUB_APP_INSTALLATION_ID`, configured the same way) or the PAT fallback below.
- **GitHub App (preferred), same account** — install the App on the additional repo (GitHub → the
  App's settings → **Configure** → **Repository access** → add the repo, or switch the installation to
  "All repositories" for account-wide reach *within that one account*) and note that the same
  `FLEET_GITHUB_APP_INSTALLATION_ID` covers every repo the installation has access to; no fleet-side
  config changes with the new repo. Each cast still only ever gets a token narrowed to its own `repo`
  (see the security notes above) — adding a repo to the installation makes it *reachable*, not
  automatically *accessible* to every cast, since the per-cast token only ever includes the repo that
  specific cast named. If a cast names a repo the installation can't reach (wrong account, or never
  added under Repository access), token minting fails fast with an error naming the installation id
  and the unreachable repo — there is no silent fallback to a broader, unscoped token.
- **PAT fallback** — a classic PAT already covers every repo its owner can access; a fine-grained PAT
  must have the new repo added explicitly under **Repository access** (GitHub → Settings → Developer
  settings → Personal access tokens → the token → Repository access). Either way this is a single
  shared credential with no per-cast narrowing, so widening it widens every cast's reach at once — the
  GitHub App path is preferred specifically because it keeps that reach scoped down per cast instead.
- **`codeAccess: "clone"`** needs no GitHub read access for its initial checkout at all (see above),
  but does need the `pi-project-lead` process's own **local** working directory to already be a
  checkout of the target repo (it archives `process.cwd()`) — so casting a second repo with
  `codeAccess: "clone"` means running `pi-project-lead` from a local checkout of *that* repo, not
  pi-fleet's. `codeAccess: "pr"`/`"branch"` have no such requirement — the sandbox clones the target
  itself over the network — which makes them the simplest way to validate a brand-new repo end-to-end.

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

# Lost the local job record? Reconnect to the still-running sandbox directly:
e2b_status({ sandboxId: "<e2b-sandbox-id>" })
e2b_logs({ sandboxId: "<e2b-sandbox-id>" })
# The live result/log data rehydrates a local job record where possible.
```
