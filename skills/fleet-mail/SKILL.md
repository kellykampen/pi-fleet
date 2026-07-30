---
name: fleet-mail
description: Use the fleet-mail CLI for async status between fleet seats (workers → project-lead only). Prefer replaceable status slots over cmux mid-turn steers. Works for Pi, Claude Code, and Codex CLI via the same binary.
---

# fleet-mail (multi-harness)

Single backend for agent mail. **Shell out to `fleet-mail`** — do not invent a second inbox,
and do not drip status via `cmux send` into a busy lead/conductor pane.

## When to use

- Worker progress / blocker / done / ask → **owning project lead**
- Lead compact rollup → **conductor**
- Lead (or conductor) reading unread mail on **idle / cadence**, then **ack**

## Commands

```bash
# Worker → *named* lead (STATUS slot replaces prior unacked status for same ticket)
# Lead mailbox MUST equal cmux pane/tab name: <workspace_name>-project-lead
fleet-mail send \
  --from worker:<ticket-or-seat> \
  --to pi-fleet-project-lead \
  --type status \
  --ticket <TICKET> \
  --body "compact progress" \
  [--pr URL] [--head SHA]

fleet-mail send --from worker --to pi-fleet-project-lead --type <TYPE> --ticket <TICKET> --body "…"
# <TYPE> is one of: blocker, done, ask

# Lead pull (idle / cadence — not mid-tool thrash)
fleet-mail inbox --mailbox "$FLEET_LEAD_MAILBOX" --unread   # e.g. pi-fleet-project-lead
fleet-mail show  --mailbox "$FLEET_LEAD_MAILBOX" [--id ID]
fleet-mail ack   --mailbox "$FLEET_LEAD_MAILBOX" --id <id>

# Lead → conductor rollup only (never raw worker spam)
fleet-mail send --from "$FLEET_LEAD_MAILBOX" --to conductor --type status --ticket <TICKET> \
  --body "T: implementer done; reviewer in flight"
```

Env defaults: `FLEET_MAIL_FROM`, `FLEET_MAIL_TO`, `FLEET_LEAD_MAILBOX`, `FLEET_PROJECT_KEY`,
`PI_FLEET_HOME` (default `~/.pi-fleet`).

## Topology (enforced — CLI fails closed)

| From | To |
| --- | --- |
| worker / reviewer / ac-verifier | **project-lead only** (named `<ws>-project-lead` or legacy) |
| project-lead | conductor (rollups), workers |
| conductor | project-lead only (use **named** mailbox when known) |

### Lead naming (FLT-68)

Preferred mailbox / seat name: **`<workspace_name>-project-lead`**
(e.g. `agent-skills-project-lead`, `ftd-project-lead`, `pi-fleet-project-lead`).
Must match the cmux pane/tab name exactly. Named form is first-class in topology
(no more `unknown mailbox role` on `pi-fleet-project-lead`). Legacy bare
`project-lead` / `project-lead:<scope>` still accepted.

Never `worker → conductor`. Never mid-task drip-feed. Prefer **one replaceable status** per ticket.

## Harness notes

| Harness | Integration |
| --- | --- |
| **Pi** | Skill loaded by implementer/lead/conductor; bash policy allows `fleet-mail *` |
| **Claude Code** | Prompt + Bash allow for `fleet-mail`; this skill can live under Claude skills path |
| **Codex CLI** | Merge [`docs/AGENTS.fleet-mail.md`](../../docs/AGENTS.fleet-mail.md) into project `AGENTS.md`; full guide [`docs/codex-fleet-mail.md`](../../docs/codex-fleet-mail.md) |

Contract: [`docs/agent-mail.md`](../../docs/agent-mail.md).  
Batch/append decision: [`docs/batch-append-messaging.md`](../../docs/batch-append-messaging.md).

## Lead rule (anti-thrash)

- **Do not** `cmux send` status into a lead that is mid-turn / mid-tool batch for routine updates.
- Workers write mail; lead **pulls** when idle or on a short cadence.
- At most **one** optional idle nudge (handoff file or single message) if the lead must wake — never a steer storm.
