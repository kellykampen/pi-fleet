# Agent mail (fleet-mail) v0

First-class async inbox between pi-fleet seats. **Status uplink no longer requires
`cmux send` drip.** Workers mail their owning project lead; leads post compact
rollups to the conductor.

## Decision: pi-messenger

See [pi-messenger-decision.md](./pi-messenger-decision.md). **Custom `fleet-mail`**
(file-backed under `~/.pi-fleet/mail`) was chosen over adopting
[`npm:pi-messenger`](https://github.com/nicobailon/pi-messenger) as-is. Gaps:
free-form chat + steering-wakeup can reintroduce queue spam; no role topology;
no structured status/blocker/done/ask/review/ac types; no unread/ack; no
replaceable STATUS slots; requires a Pi extension (`--extension`) while
lead/conductor often run with `--no-extensions`.

## CLI

```bash
# Worker status uplink (default: owning lead only)
fleet-mail send \
  --from worker:flt-58 \
  --to project-lead \
  --type status \
  --ticket FLT-58 \
  --body "tests green; opening PR" \
  --pr https://github.com/org/repo/pull/12 \
  --head abc1234

# Lead inbox
fleet-mail inbox --mailbox project-lead --unread
fleet-mail show  --mailbox project-lead
fleet-mail ack   --mailbox project-lead --id <id>

# Lead → conductor compact rollup (not worker raw mail)
fleet-mail send \
  --from project-lead \
  --to conductor \
  --type status \
  --ticket FLT-58 \
  --body "FLT-58: implementer done; reviewer in flight"
```

Commands: `send` · `inbox` · `show` · `ack` · `help`.

Env:

| Variable | Purpose |
| --- | --- |
| `PI_FLEET_HOME` | Runtime root (default `~/.pi-fleet`) |
| `FLEET_MAIL_FROM` | Default `--from` |
| `FLEET_MAIL_TO` | Default `--to` (workers: set to owning lead) |
| `FLEET_MAIL_RATE_LIMIT` | Max non-status messages per window (default 30) |
| `FLEET_MAIL_RATE_WINDOW_MS` | Rate window (default 60000) |

## Message shape

```json
{
  "id": "…",
  "from": "worker:flt-58",
  "to": "project-lead",
  "type": "status|blocker|done|ask|review|ac",
  "ticket": "FLT-58",
  "pr": "https://…",
  "head": "abc123",
  "body": "compact text",
  "ts": "2026-07-30T12:00:00.000Z",
  "acked": false
}
```

## Topology (enforced in code)

| From | May mail |
| --- | --- |
| `worker`, `reviewer`, `ac-verifier` | **`project-lead` only** (never `conductor` / `coordinator`) |
| `project-lead` | `conductor` (compact rollups), workers |
| `conductor` / `coordinator` | `project-lead` only (worker mail rejected) |

Mailbox ids may be role-scoped (`project-lead:pi-fleet`, `worker:flt-58`); the
role is the segment before the first `:`. Alias: `coordinator` → `conductor`.

## Anti-spam

1. **Replaceable STATUS slots** — `type=status` **requires** `--ticket`. A new
   status from the same sender for the same ticket **replaces** the prior unacked
   status instead of appending. Status updates must replace, not flood.
2. **Rate limit** — non-status messages are capped per `from→to` window
   (default 30 / 60s). Status is exempt because it replaces.
3. **Compact body** — truncated to 4 KiB.

Optional `cmux` notify is **never required** for delivery; mail is durable on disk.

## Storage

```
$PI_FLEET_HOME/mail/<mailbox>/inbox.json   # 0600
$PI_FLEET_HOME/mail/rate/<from>__<to>.json
```

Atomic write (temp → fsync → rename), cross-process lock (5s), directory mode
`0700`. Namespace is documented in the [runtime-state contract](./runtime-state.md).

## Seat usage

- **Workers** (`pi-implementer`, reviewer, AC-verifier, …): set
  `FLEET_MAIL_TO=project-lead` (or project-scoped lead). Report status/blocker/done
  via `fleet-mail send`. Do **not** `cmux send` status drip to the conductor.
- **Project lead**: `fleet-mail inbox --unread` on a cadence; ack processed mail;
  send **compact rollups** to `conductor`. Do not forward raw worker spam.
- **Conductor**: only read lead rollups; never accept/route worker mail. If a
  worker tries `to=conductor`, the CLI fails closed.

Optional presence tooling is independent; mail works without it.

## Smoke

```bash
evals/pi-fleet-mail-smoke-test.sh
node --test evals/fleet-mail.test.mjs
```
