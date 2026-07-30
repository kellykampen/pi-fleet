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
# Worker → lead (STATUS slot replaces prior unacked status for same ticket)
fleet-mail send \
  --from worker:<ticket-or-seat> \
  --to project-lead \
  --type status \
  --ticket <TICKET> \
  --body "compact progress" \
  [--pr URL] [--head SHA]

fleet-mail send --from worker --to project-lead --type blocker|done|ask --ticket <TICKET> --body "…"

# Lead pull (idle / cadence — not mid-tool thrash)
fleet-mail inbox --mailbox project-lead --unread
fleet-mail show  --mailbox project-lead [--id ID]
fleet-mail ack   --mailbox project-lead --id <id>

# Lead → conductor rollup only (never raw worker spam)
fleet-mail send --from project-lead --to conductor --type status --ticket <TICKET> \
  --body "T: implementer done; reviewer in flight"
```

Env defaults: `FLEET_MAIL_FROM`, `FLEET_MAIL_TO`, `PI_FLEET_HOME` (default `~/.pi-fleet`).

## Topology (enforced — CLI fails closed)

| From | To |
| --- | --- |
| worker / reviewer / ac-verifier | **project-lead only** |
| project-lead | conductor (rollups), workers |
| conductor | project-lead only |

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
