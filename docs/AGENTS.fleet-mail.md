# fleet-mail (append to project AGENTS.md for Codex / multi-harness seats)

## Agent mail

Status uplink uses the **`fleet-mail` CLI** (shared file inbox under `~/.pi-fleet/mail`).
Do **not** drip mid-task status via terminal multiplexor steers into the project lead.

```bash
# Progress (replaceable per ticket)
# --to = owning lead named mailbox (<workspace>-project-lead), matching cmux pane/tab
fleet-mail send --from worker --to pi-fleet-project-lead --type status --ticket <TICKET> \
  --body "compact progress" [--pr URL] [--head SHA]

# Blocker / done / ask
fleet-mail send --from worker --to pi-fleet-project-lead --type blocker|done|ask --ticket <TICKET> --body "…"
```

- **Topology:** workers/reviewers/AC-verifiers → **project-lead only** (never conductor).
  Preferred lead id: `<workspace_name>-project-lead` (e.g. `pi-fleet-project-lead`).
- **Anti-spam:** `type=status` requires `--ticket`; a new status **replaces** the prior unacked
  status for the same sender+ticket.
- Lead pulls with `fleet-mail inbox --mailbox <workspace>-project-lead --unread` on idle/cadence, then acks.
- Env: `FLEET_MAIL_FROM`, `FLEET_MAIL_TO` (named lead), `FLEET_LEAD_MAILBOX`, `PI_FLEET_HOME`.

See pi-fleet `docs/agent-mail.md` and `docs/codex-fleet-mail.md` when those paths are available.
