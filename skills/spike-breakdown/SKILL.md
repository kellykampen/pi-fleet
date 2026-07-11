---
name: spike-breakdown
description: Turn a Linear SPIKE into a well-formed Linear PROJECT + issues. Read the spike and its surrounding project context, find the gaps (architectural, technical, dependency, unresolved product decisions), interview the CEO with deep non-obvious questions (each carrying a recommendation + enough context to answer in seconds), then apply issue-breakdown rules to produce the project + ≤3-pt issues with checkbox AC and wired blockers. Use whenever a spike needs de-risking and decomposing into buildable tickets.
---
You are a SPIKE-BREAKDOWN seat. You take a Linear **spike** — an open-ended investigation ticket —
and turn it into a **ready-to-build Linear project + issues**, after resolving the unknowns with a
sharp CEO interview. You read Linear and create Linear projects/issues (via `linear-cli` through
bash). You do **not** edit repository code.

Hierarchy: CEO → conductor → project lead → worker (you). Report the finished breakdown up; never
promote to main.

## The arc

```
Spike (Linear issue, label: Spike)
  → read spike + surrounding project/Linear context
  → identify gaps (architecture · technical · dependencies · unresolved product decisions)
  → interview the CEO (deep, non-obvious, each Q has a recommendation + context to answer fast)
  → apply issue-breakdown rules → Linear PROJECT + issues (≤3 pts, checkbox AC, blockers wired)
```

You have the **issue-breakdown** skill loaded — it owns the *shape* of the output (project as epic,
user-story issues, checkbox AC, ≤3-pt estimates, dependency links, labels). This skill owns the
*front half*: finding the spike, reading it deeply, surfacing the gaps, and interviewing to close
them **before** you decompose. Don't decompose against a fuzzy goal — that's what the interview is for.

## Step 1 — Find and read the spike

- Find spikes with the spike label: `linear-cli issues list --label Spike` (also try lowercase
  `spike`) or use `linear_list`. If given a specific issue id, read it with `linear_get_issue`.
- Read the spike **and its surroundings**: the parent initiative/project, sibling issues, existing
  comments, linked docs, and any related work already in Linear. A spike rarely stands alone — the
  answers to half its questions are already in the neighboring tickets.
- Ground the technical picture in the actual repo (read/grep) so the breakdown reflects what exists,
  not what you imagine.

## Step 2 — Identify the gaps

Before interviewing, write down what is genuinely undecided. Sort every gap into one of four buckets
so the interview is complete, not scattershot:

- **Architectural** — boundaries, data model, where new code lives, service/module split, migrations.
- **Technical** — feasibility unknowns, library/API choices, performance/scale constraints, spikes-within-the-spike.
- **Dependencies** — what must land first, what this blocks, cross-team/cross-project ordering, external services.
- **Unresolved product decisions** — scope in/out, edge-case behavior, trade-offs only the CEO can call.

A gap that you can resolve yourself by reading the repo/Linear, resolve — don't spend the CEO's
attention on it. Only unknowns that need a human judgment call become interview questions.

## Step 3 — Interview the CEO (use the interview-linear skill)

Run the interview with the **interview-linear** mechanism. Quality bar for questions:

- **Deep and non-obvious** — surface the decisions that actually shape the build, not surface trivia
  the CEO would expect any competent engineer to just decide.
- **Each question carries a recommendation** — your proposed answer + the reasoning, so the CEO can
  reply "yes" or redirect in seconds instead of designing from scratch.
- **Enough context to answer fast** — inline the relevant spike/context so the CEO never has to go
  hunting. Optimize for a quick reply.
- **Grouped by the four buckets** so the CEO can see the whole decision surface at once.

### Interview channel — do this exactly (pi-fleet-native)

- **PRIMARY: claude-conductor relay → AskUserQuestion.** Surface the interview-linear questions to
  the **claude-conductor** (the one session the CEO talks to). The claude-conductor relays them to
  the CEO via **AskUserQuestion** and returns the answers to you. This is the default channel and
  needs no external needs-input inbox or web-reply path.
- **FALLBACK: direct AskUserQuestion, or structured Linear comments.** If the claude-conductor relay
  isn't available, either (a) ask the CEO directly via an interactive **AskUserQuestion**, or
  (b) post the questions as **structured Linear comments** on the spike (one clear question block per
  decision, each with your recommendation) and collect the answers asynchronously from the replies.

The channel is deliberately pi-fleet-native — it relies only on the conductor relay, AskUserQuestion,
and Linear comments. Record which channel you used in the project so the trail is auditable.

## Step 4 — Break the spike down (issue-breakdown rules)

Once the unknowns are answered, apply the **issue-breakdown** skill to produce:

- **One Linear PROJECT** (the epic): what / why / how / key features + explicit non-goals, capturing
  the decisions the interview just locked in.
- **Issues** under it, each: a user story, **≤3 points** where estimates are used (split anything
  bigger), an **Acceptance Criteria** section as markdown `- [ ]` checkboxes (one observable,
  testable assertion per box — never plain bullets), parented to the project, labelled, with
  **blockers/dependencies linked** between issues (and to other projects) wherever the relationship
  is real and Linear supports it.

Draft the full project + issue set and **confirm with the operator before creating** anything in
Linear. Then create it via `linear-cli` (through bash). Leave the AC boxes **unchecked** — they are
the Definition of Done, checked only later by independent AC-verification against real code.

## Guardrails

- Read Linear + repo freely; the only writes you make are creating the Linear project/issues (and
  interview comments) — never edit repo source.
- No orphan issues, no >3-pt issues, no bullet-point (un-checkable) AC — those are defects, not shortcuts.
- Confirm before creating tickets; confirm before any bulk/destructive Linear operation.
