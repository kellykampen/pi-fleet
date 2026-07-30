# Codex CLI + fleet-mail

Codex (and any non-Pi harness) uses the **same** `fleet-mail` binary as Pi seats.
There is no separate Codex mail protocol.

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
export FLEET_MAIL_TO=project-lead   # or project-lead:<project-key>

# Replaceable progress (same ticket overwrites prior unacked status)
fleet-mail send --type status --ticket FLT-63 --body "tests green; opening PR" --pr "$PR_URL" --head "$(git rev-parse --short HEAD)"

# Final
fleet-mail send --type done --ticket FLT-63 --body "PR #N ready; sha abc1234"
```

Rules:

- Mail **project-lead only** — never conductor.
- Prefer `type=status` with `--ticket` over repeated chat/status steers.
- Do not depend on the lead receiving a mid-turn interrupt; mail is durable until ack.

## Lead pattern (if Codex is the lead harness)

```bash
fleet-mail inbox --mailbox project-lead --unread
fleet-mail show  --mailbox project-lead
fleet-mail ack   --mailbox project-lead --id <id>

fleet-mail send --from project-lead --to conductor --type status --ticket FLT-63 \
  --body "FLT-63: implementer done; reviewer in flight"
```

Pull on **idle / cadence**. Do not inject routine status as steers into a busy session.

## Smoke

```bash
evals/pi-fleet-mail-smoke-test.sh
# or
fleet-mail send --from worker:demo --to project-lead --type status --ticket DEMO --body hi
fleet-mail inbox --mailbox project-lead --unread
```

Full contract: [agent-mail.md](./agent-mail.md). Decision: [batch-append-messaging.md](./batch-append-messaging.md).
