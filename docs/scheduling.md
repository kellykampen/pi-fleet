# Scheduling — recurring prompts for long-running seats

Long-running seats — `pi-conductor`, `pi-project-lead`, and a personal-assistant seat — benefit from
**recurring self-prompts**: portfolio checkups, CI polling, reminders, autonomous follow-ups.

## Personal-assistant schedules (instance-local)

`pi-personal-assistant` manages its own schedules **locally** via macOS `launchd`:

- Source of truth: `profiles/personal-assistant/schedules.json`
- Sync: `bin/pi-personal-schedule-sync` runs on every `pi-personal-assistant` start
- Firing: `bin/pi-personal-schedule-run <name>` is invoked by `launchd` and runs the checkup one-shot through `pi-personal-assistant`
- Logs: `~/Library/Logs/pi-fleet/<name>.log` and `<name>.error.log`
- Installed plists: `~/Library/LaunchAgents/dev.pi-fleet.personal.*.plist`

This keeps the schedules **bound to the personal-assistant instance**:
`pi-conductor`, `pi-project-lead`, and other profiles never install or fire them, and the global
`~/.pi/agent/state/scheduler/tasks.json` remains empty. Conductor and project-lead wrappers print a
read-only startup status (`0 global scheduled actions`) so scheduler isolation is visible at runtime.

Current schedules:

| Schedule | Cron | Meaning |
|----------|------|---------|
| `social-x-checkup` | `0 0 * * * *` | top of every hour |
| `gmail-reply-checkup` | `0 5 * * * *` | five minutes past every hour |

See `docs/personal-schedules.md` for full details.

## ⚠️ Avoid machine-global scheduler extensions

The old machine-global scheduler stored jobs in `~/.pi/agent/state/scheduler/tasks.json` and
leaked scheduled actions into every pi instance. That store is now kept empty; personal checkups
are recreated locally from the personal-assistant profile instead.

## Historical: `@jl1990/pi-scheduler` and `pi-schedule-prompt`

These remain documented below only for reference. New schedules should use the personal-assistant
launchd mechanism above.

### `@jl1990/pi-scheduler`

```bash
pi install npm:@jl1990/pi-scheduler
```

- **Agent-callable tools:** `schedule_task`, `list_scheduled_tasks`, `cancel_scheduled_task`,
  `manage_scheduled_task` — the agent schedules its own future work from inside the conversation.
- **Types:** `once` · `interval` · `cron` (via [`croner`](https://github.com/hexagon/croner)).
  **Actions:** `notify` · `prompt` · `shell` · `message`.
- **State:** `~/.pi/agent/state/scheduler/tasks.json` (global — survives `/reload`).
- **UI:** a compact, **toggleable** belowEditor widget (`/schedule-widget` on/off) showing the next
  few actions. **No full-screen overlay** — it never steals input focus.

Example (an agent scheduling its own hourly checkup):

```
schedule_task({ type: "cron", schedule: "0 0 * * * *", action: "prompt",
                name: "portfolio-checkup", prompt: "…", model: "openai-codex/gpt-5.5" })
```

### ⚠️ Avoid `pi-schedule-prompt` — its overlay blocks the pane

`pi-schedule-prompt` renders a **full-screen, hotkey-driven Jobs overlay** (`/schedule-prompt`). In a
cmux / multi-pane fleet it can get **stuck open and swallow all typed input** to that pane: the seat
becomes unreachable — `cmux send` text and Enter don't register, only the overlay's hotkeys
(`↑↓/a/t/x/q/esc`) do. A failing scheduled job makes it worse (it re-surfaces the overlay). This
manifests as "my sends to the seat aren't landing" while the seat looks alive.

### Recovery / swap procedure

```bash
# 1. swap the package (machine-level; not a repo change)
pi remove npm:pi-schedule-prompt
pi install npm:@jl1990/pi-scheduler

# 2. clear the old scheduler's jobs (per seat cwd + global)
echo '{"jobs":[]}' > <seat-cwd>/.pi/schedule-prompts.json
```

Then, **in each running seat** (no restart needed — `/reload` live-swaps extensions):

1. Press **`q`** to close the stuck overlay (the one keystroke that lands).
2. Run **`/reload`** — reloads keybindings/extensions/skills; drops the removed overlay, loads the
   new scheduler.
3. Re-create schedules with `schedule_task` (state is global, so it persists across future reloads).

After this the seat is reachable again and shows the compact widget instead of the overlay.
