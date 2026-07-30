# Codex CLI + fleet-mail

**`fleet-mail` is the DEFAULT fleet communication channel.** Codex (and any non-Pi harness)
uses the **same** `fleet-mail` binary as Pi seats. There is no separate Codex mail protocol.
Agent-to-agent via fleet-mail, not terminal multiplexor steers — except launch / bootstrap /
emergency.

## Prerequisites

1. `fleet-mail` on `PATH` (from this repo: `export PATH="$HOME/code/pi-fleet/bin:$PATH"`).
2. Writable `PI_FLEET_HOME` (default `~/.pi-fleet`).
3. Shared machine / shared home with the owning project-lead mailbox (local file store).

## Install skill text into a Codex project

Copy or merge the fragment:

- [`AGENTS.fleet-mail.md`](./AGENTS.fleet-mail.md) → append to the project's `AGENTS.md`
  (or Codex-equivalent project instructions file).

Optional: copy `skills/fleet-mail/SKILL.md` into whatever skill directory your Codex
setup loads, if it supports skill packs — still shell out to the CLI; do not reimplement.

## Worker pattern (Codex implementer)

```bash
export FLEET_MAIL_FROM=worker:my-ticket
# FLT-68: named lead mailbox matches cmux pane/tab (<workspace>-project-lead)
export FLEET_MAIL_TO=pi-fleet-project-lead

# Replaceable progress (same ticket overwrites prior unacked status)
fleet-mail send --type status --ticket FLT-63 --body "tests green; opening PR" --pr "$PR_URL" --head "$(git rev-parse --short HEAD)"

# Final
fleet-mail send --type done --ticket FLT-63 --body "PR #N ready; sha abc1234"
```

Rules:

- Mail **project-lead only** — never conductor. Prefer the **named** lead id
  (`<workspace_name>-project-lead`, e.g. `pi-fleet-project-lead`).
- Prefer `type=status` with `--ticket` over repeated chat/status steers.
- Do not depend on the lead receiving a mid-turn interrupt; mail is durable until ack.

## Lead pattern (if Codex is the lead harness)

```bash
export FLEET_LEAD_MAILBOX=pi-fleet-project-lead   # must match cmux pane/tab
fleet-mail inbox --mailbox "$FLEET_LEAD_MAILBOX" --unread
fleet-mail show  --mailbox "$FLEET_LEAD_MAILBOX"
fleet-mail ack   --mailbox "$FLEET_LEAD_MAILBOX" --id <id>

fleet-mail send --from "$FLEET_LEAD_MAILBOX" --to conductor --type status --ticket FLT-63 \
  --body "FLT-63: implementer done; reviewer in flight"
```

Pull on **startup**, every **task boundary**, every **5–10 min**, and **before reporting blocked
or done**. Do not inject routine status as steers into a busy session.

## Smoke

```bash
evals/pi-fleet-mail-smoke-test.sh
evals/lead-named-mailbox-structural-test.sh
# or
fleet-mail send --from worker:demo --to pi-fleet-project-lead --type status --ticket DEMO --body hi
fleet-mail inbox --mailbox pi-fleet-project-lead --unread
```

Full contract: [agent-mail.md](./agent-mail.md). Decision: [batch-append-messaging.md](./batch-append-messaging.md).
