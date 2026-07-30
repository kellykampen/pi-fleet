# Batch / append messaging decision (FLT-63)

**Ticket:** [FLT-63](https://linear.app/dojoco/issue/FLT-63/batchappend-messaging-multi-harness-agent-mail)  
**Date:** 2026-07-30  
**Related:** FLT-58 (`fleet-mail` v0), FLT-59 (pi-messenger no-go), FLT-57 (topology)

## Recommendation (adopt)

**Ship one mail backend + CLI: `fleet-mail` (extend FLT-58).**  
Do **not** adopt `npm:pi-messenger` as the fleet status channel.  
Do **not** build a Pi-only followUp extension as the primary path.  
Installable skill/docs for **Pi, Codex CLI, and Claude Code** all shell out to the **same** `fleet-mail` CLI.  
Topology remains **workers → project-lead only**; leads roll up to conductor; **replaceable status slots**.

---

## Answers (full text)

### 1. Does Pi support non-steer delivery (followUp / nextTurn / append inbox) via extension API or RPC?

**Yes — partially, and only inside a live Pi session.**

From Pi extension + RPC docs (`@earendil-works/pi-coding-agent`):

| Mechanism | Semantics | Interrupt? |
| --- | --- | --- |
| `pi.sendMessage(..., { deliverAs: "steer" })` | After current tool batch, before next LLM call | **Yes** (mid-run steer) |
| `pi.sendMessage(..., { deliverAs: "followUp" })` | When agent has no more tools/steering | Soft queue until idle-ish |
| `pi.sendMessage(..., { deliverAs: "nextTurn" })` | Queued for **next user prompt**; does not interrupt or trigger | **No** auto-turn |
| `pi.sendUserMessage(text, { deliverAs: "steer" \| "followUp" })` | Real user message; **always triggers a turn** when delivered | Steer or followUp while streaming |
| RPC `steer` / `follow_up` / `prompt` with `streamingBehavior` | Same dual queue as interactive Enter / Alt+Enter | Same |

There is **no first-class durable multi-agent inbox API** in Pi core (no role mailboxes, no ack, no replaceable status slots). Non-steer modes still land as **session queue messages**, not a pullable fleet store.

### 2. Can pi-messenger use that instead of `deliverAs: "steer"`?

**In theory a fork/wrap could; as-shipped product does not.**

`pi-messenger` (npm 0.14.1) documents messaging as: **recipient wakes as a steering prompt**. That is the product design, not an accident. Even if we patched delivery to `followUp`/`nextTurn`:

- Still free-form chat, not structured `{type, ticket, pr, head}`
- Still no workers→lead-only topology
- Still no unread/ack or replaceable STATUS slots
- Still a **Pi extension** (lead/conductor often run `--no-extensions` / isolated extension sets)
- Still **Pi-only** — Codex CLI and Claude Code seats cannot load it

So “use followUp inside pi-messenger” does **not** solve multi-harness mail or anti-spam topology.

### 3. Build fleet-mail file inbox + skill read-on-idle, or thin extension with followUp `sendUserMessage`?

**Build / extend file-backed `fleet-mail` + skill-enforced idle/cadence read.**  
Optional thin Pi extension that *notifies* on new mail via `followUp`/`nextTurn` is a future nicety, **not** the transport of record.

| Option | Verdict |
| --- | --- |
| A. Pi extension only (`sendUserMessage` followUp) | **Reject as primary** — Pi-only; requires extension load; no durable ack store shared with Claude/Codex; still injects into session context |
| B. Wrap pi-messenger with followUp | **Reject** — wrap cost > custom CLI; steering DNA; multi-harness gap remains |
| C. **`fleet-mail` file inbox + idle/cadence pull** | **Adopt** — works for every harness that can shell out; topology + status slots in code; lead chooses when to read |

**Lead policy (this ticket):** do **not** `cmux send` mid-turn status into a busy lead pane.
`fleet-mail` is the **DEFAULT** fleet communication channel (cmux only for launch / bootstrap /
emergency). Workers write mail; lead runs `fleet-mail inbox --unread` on **startup**, every
**task boundary**, every **5–10 min**, and **before reporting blocked or done**, then acks. One
optional idle message or handoff file is enough when the lead must be nudged — never a drip of steers.

### 4. Must work for Pi; ship installable skills/docs for Codex + Claude Code calling the same CLI/backend

**Yes — single backend, multi-client.**

| Harness | How it uses mail |
| --- | --- |
| Pi seats | Skill prose + bash allowlist (`fleet-mail *`) |
| Claude Code | `skills/claude-worker` prompt + Bash allow for `fleet-mail`; optional Claude skill copy under `skills/fleet-mail/` |
| Codex CLI | `docs/codex-fleet-mail.md` + drop-in `AGENTS.fleet-mail.md` fragment to merge into project `AGENTS.md` |

All three call:

```bash
fleet-mail send|inbox|show|ack
```

Storage: `$PI_FLEET_HOME/mail` (default `~/.pi-fleet/mail`).

### 5. Topology: workers→lead only; lead→coordinator rollups; replaceable status slots

**Already enforced in `bin/lib/fleet-mail.cjs` (FLT-58); kept as hard product rules:**

- `worker|reviewer|ac-verifier` → **project-lead only** (never conductor)
- `project-lead` → conductor compact rollups (and workers for briefs if needed)
- `conductor` → project-lead only; **rejects worker mail**
- Lead mailbox preferred form (FLT-68): `<workspace_name>-project-lead` (matches cmux pane/tab;
  e.g. `pi-fleet-project-lead`). Named leads are first-class topology peers of bare `project-lead`.
- `type=status` **requires** `--ticket`; new status **replaces** prior unacked status for same from→to+ticket slot

---

## Why not “just use cmux send less carefully”

cmux send into a running Pi session becomes **steering** (or competes with the human/agent input queue). Batch append messaging’s goal is to **stop thrashing leads** with many mid-turn steers. Durable pull + replaceable slots is the fix; fewer steers is not enough without a store.

## Implementation map

| Artifact | Role |
| --- | --- |
| `bin/fleet-mail` + `bin/lib/fleet-mail.cjs` | One backend + CLI |
| `docs/agent-mail.md` | Contract |
| `docs/pi-messenger-decision.md` | FLT-59 no-go on messenger |
| `docs/batch-append-messaging.md` | This FLT-63 decision |
| `docs/codex-fleet-mail.md` + `docs/AGENTS.fleet-mail.md` | Codex install path |
| `skills/fleet-mail/SKILL.md` | Installable multi-harness skill |
| `skills/project-lead/SKILL.md` | Idle/cadence inbox; no mid-turn cmux status drip |
| `skills/implementation/SKILL.md` + Claude worker prompt | Workers send mail, not cmux drip |
| `evals/pi-fleet-mail-smoke-test.sh` + unit/structural tests | Prove CLI + multi-harness docs |

## Revisit

Reconsider a Pi-only followUp notifier **only after** fleet-mail is default across harnesses and leads still miss mail without a nudge — and only as an opt-in extension that **reads** the same inbox, never as a second message store.
