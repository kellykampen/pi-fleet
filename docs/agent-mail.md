# Agent mail (fleet-mail) v0

**`fleet-mail` is the DEFAULT fleet communication channel** for agent-to-agent
messages. First-class async inbox between pi-fleet seats. **Status uplink no longer
requires `cmux send` drip.** Workers mail their owning project lead; leads post
compact rollups to the conductor.

## DEFAULT channel rules

| Rule | Detail |
| --- | --- |
| **DEFAULT transport** | Agent-to-agent status, blockers, done, asks, review/AC reports, and lead→conductor rollups go through **`fleet-mail`**, not cmux. |
| **cmux exceptions only** | `cmux send` / `cmux send-key` are allowed for **launch**, **bootstrap** (cast + initial brief), and **emergency** (seat hung / unresponsive and mail alone cannot recover). Not for routine status. |
| **mailbox == pane name** | The fleet-mail mailbox id **is** the cmux pane/tab name. |
| **Lead mailbox** | Project leads are named `<workspace_name>-project-lead` (e.g. `pi-fleet-project-lead`). |
| **Topology** | `worker → project-lead → conductor` (enforced). Never `worker → conductor`. |

### Poll cadence (mandatory pull points)

Seats that **read** mail (project leads, conductor) **must** poll
`fleet-mail inbox --mailbox <id> --unread` at least at these points:

1. **On startup** — before routing new work or casting further seats.
2. **At every task boundary** — after a cast lands, a PR opens, a gate flips, or
   a ticket starts/finishes.
3. **Every 5–10 min** while seats are in flight (same window as lead→conductor
   rollups; do not open a continuous pane-tail channel).
4. **Before reporting blocked or done** — drain unread mail so decisions use
   current evidence, then report (or roll up) with that context.

Workers **write** mail at status/blocker/done/ask moments; they do not need an
inbox poll loop. Prefer one replaceable `type=status --ticket T` over floods.

## Decision: pi-messenger + batch/append (FLT-58 / FLT-59 / FLT-63)

See [pi-messenger-decision.md](./pi-messenger-decision.md) and
[batch-append-messaging.md](./batch-append-messaging.md).

**Custom `fleet-mail`** (file-backed under `~/.pi-fleet/mail`) is the one multi-harness
backend and the **DEFAULT** agent-to-agent channel. Do **not** adopt
[`npm:pi-messenger`](https://github.com/nicobailon/pi-messenger) as-is
(steering-wakeup spam; no role topology; no structured types/ack/status slots;
Pi extension only). Do **not** make a Pi-only `followUp`/`sendUserMessage` extension the
transport of record — Pi *does* support non-steer delivery (`deliverAs: "followUp"` |
`"nextTurn"`), but that is session-queue injection, not a durable fleet inbox, and it
does not serve Codex or Claude Code.

**Lead policy:** pull inbox on startup / task boundary / 5–10 min cadence / before
blocked-done; **do not** cmux-send mid-turn status drips (except launch/bootstrap/emergency).

## CLI

```bash
# Worker status uplink (default: owning *named* lead only — FLT-68)
fleet-mail send \
  --from worker:flt-58 \
  --to pi-fleet-project-lead \
  --type status \
  --ticket FLT-58 \
  --body "tests green; opening PR" \
  --pr https://github.com/org/repo/pull/12 \
  --head abc1234

# Lead inbox (mailbox == cmux pane/tab name)
fleet-mail inbox --mailbox pi-fleet-project-lead --unread
fleet-mail show  --mailbox pi-fleet-project-lead
fleet-mail ack   --mailbox pi-fleet-project-lead --id <id>

# Lead → conductor compact rollup (not worker raw mail)
fleet-mail send \
  --from pi-fleet-project-lead \
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
| `worker`, `reviewer`, `ac-verifier` | **project-lead only** (never `conductor` / `coordinator`) |
| project-lead | `conductor` (compact rollups), workers |
| `conductor` / `coordinator` | project-lead only (worker mail rejected) |

### Lead mailbox naming (FLT-68) — source of truth

Project-lead seats **MUST** be named on startup exactly:

```text
<workspace_name>-project-lead
```

Examples: `agent-skills-project-lead`, `ftd-project-lead`, `pi-fleet-project-lead`.

That string is **both**:

1. the cmux pane/tab name, and
2. the `fleet-mail` mailbox id (`--from` / `--to` / `--mailbox`).

Conductor named send and worker uplink must use this id. Do **not** fall back to
bare `project-lead` when a workspace name is known — that is what caused named
sends to reject (`unknown mailbox role: pi-fleet-project-lead`) and forced a
generic fallback.

Also accepted for compatibility:

- bare `project-lead`
- legacy scoped `project-lead:<scope>` (e.g. `project-lead:pi-fleet`)
- worker-scoped ids (`worker:flt-58`) — role is the segment before the first `:`

Alias: `coordinator` → `conductor`.

Launch helpers export `FLEET_LEAD_MAILBOX` / `FLEET_MAIL_FROM` via
`bin/lib/fleet-lead-mailbox.sh` (wired into `pi-project-lead` and
`claude-project-lead`). Prefer `FLEET_PROJECT_KEY` or `CMUX_WORKSPACE_NAME`.

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

- **Workers** (Pi `pi-implementer`, Claude `claude-worker`, Codex CLI, reviewer,
  AC-verifier, …): set `FLEET_MAIL_TO=<workspace>-project-lead` (exact lead seat /
  pane name; e.g. `pi-fleet-project-lead`). Report status/blocker/done via
  `fleet-mail send` — this is the **DEFAULT** uplink. Do **not** `cmux send` status
  drip to the conductor or thrash the lead mid-turn. Mail **before** reporting
  blocked or done so the lead has durable evidence.
- **Project lead**: poll `fleet-mail inbox --mailbox "$FLEET_LEAD_MAILBOX" --unread`
  on **startup**, at every **task boundary**, every **5–10 min** while seats run, and
  **before reporting blocked or done** — **not** mid-tool-batch steers for routine
  mail. Ack processed mail; send **compact rollups** to `conductor` with
  `--from "$FLEET_LEAD_MAILBOX"`. Do not forward raw worker spam. Optional: one idle
  nudge / handoff file if blocked on the lead — never a steer storm. `cmux` is only
  for launch / bootstrap / emergency.
- **Conductor**: mail each lead at its **named** mailbox (`--to <ws>-project-lead`);
  only read lead rollups; never accept/route worker mail. Poll `conductor` inbox on
  **startup**, task boundary, **5–10 min**, and before blocked/done portfolio reports.
  If a worker tries `to=conductor`, the CLI fails closed. Do not fall back to generic
  `project-lead` when the named mailbox is known.

### Multi-harness install

| Harness | Path |
| --- | --- |
| Pi | `skills/fleet-mail`, implementer/lead/conductor skills |
| Claude Code | `skills/claude-worker/PROMPT.md` + `Bash(fleet-mail:*)` on `claude-worker` |
| Codex CLI | [codex-fleet-mail.md](./codex-fleet-mail.md) + [AGENTS.fleet-mail.md](./AGENTS.fleet-mail.md) |

Optional presence tooling is independent; mail works without it.

## Smoke

```bash
evals/pi-fleet-mail-smoke-test.sh
node --test evals/fleet-mail.test.mjs
evals/batch-mail-structural-test.sh
evals/lead-named-mailbox-structural-test.sh
```
