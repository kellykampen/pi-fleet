# pi-fleet

Versioned, reusable **agent profiles** for the [Pi coding agent](https://pi.dev) — each one a
restricted "seat" with a fixed toolset, model, and skill. Launch any of them from the terminal
with a single command.

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
| **`pi-implementer`** | GPT-5.6 Sol (`openai-codex`) · high | read, grep, find, ls, **write, edit, bash** | Builds one ticket end-to-end in a worktree (code + tests → PR). Override to Kimi `k2p7` for simple, fully-specified work. |
| **`pi-reviewer`** | Kimi K2.7 (`kimi-coding`) · medium | read, grep, find, ls *(no bash/write)* | Independent **read-only** code review/QC. Must run on a **different model** than the implementer — if the build used Kimi, override this to another provider. |
| **`pi-researcher`** | Kimi K2.7 · low | read, grep, find, ls | Read-only scouting / codebase investigation. |
| **`pi-orchestrator`** | GPT-5.5 · high | read, grep, find, ls, write, edit, bash | Project orchestrator — delegates to worker seats, holds the QC gates. |
| **`pi-visual-qa`** | Gemini 3.1 Pro (`openrouter`) · medium | read, grep, find, ls *(+ image input)* | Compares an app screenshot to the design comp (vision model). |
| **`pi-linear`** | Kimi K2.7 · low | read, grep, find, ls + `linear_*` | Linear issue/project management (via the bundled `linear.ts` extension). |
| **`pi-personal-assistant`** | **GPT-5.6 Terra** (`openai-codex`) · medium | read, grep, find, ls, write, edit, bash + `linear_*` | The operator's **personal assistant** — social/X, comms, notes, tasks. Runs the CLIs below under a **draft → approval → execute** gate (nothing sends/posts without an explicit per-item OK). |

The `pi-personal-assistant` toolkit (all via `bash`, documented in its skill):
`finch` (X) · `gog` (Google Workspace) · `imsg` (iMessage) · `wacli` (WhatsApp) ·
`obsidian-cli` (Obsidian) · `ntn` (Notion) · `linear-cli` · `gh`/`git`.

**Models are defaults, not locks.** Each profile's model is a sensible fallback so `pi-<role>` runs
standalone — but the **`pi-orchestrator`** picks the model per task using the **model-classifier
skill** (loaded into it) and overrides via `--provider/--model` on the cast. So routing = "which
worker profile + which model," decided per task, not baked rigidly into the profile.

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
├── extensions/linear.ts          # Pi extension exposing narrow linear_* tools (no bash needed)
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
