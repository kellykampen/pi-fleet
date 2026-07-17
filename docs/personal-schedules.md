# Personal Pi global prompt schedules (FLT-24)

`pi-personal-assistant` recreates two personal launchd prompt schedules on every start/restart,
idempotently (updates existing jobs in place rather than duplicating them). They are never written
to pi's machine-global scheduler store.

## Why launchd, not a cloud scheduler

Both checkups need read-only access to local CLIs (`finch`, `gog`) and their local auth state.
Two alternatives were considered and rejected 2026-07-11:

- **Claude's cloud `schedule`/RemoteTrigger routines** — runs in an isolated Anthropic sandbox
  with no access to local files, local services, or local env — can't reach `finch`/`gog`.
- **The in-session `CronCreate` tool** — session-only; the job dies when the Claude session ends,
  so it can't survive a Personal Pi restart.

launchd (macOS) is local, survives restarts/logouts, and needs no extra dependency.

## Source of truth

`profiles/personal-assistant/schedules.json` — one entry per schedule: `name`, `cron` (6-field:
`sec min hour dom month dow`), `purpose`, `source`, `commandsFirst`, `fallback`,
`hardConstraints`, `output`, `escalation`, `taskId`, `roster` (prefer/banned), `enabled`.

| Schedule | Cron (6-field) | Meaning |
| --- | --- | --- |
| `social-x-checkup` | `0 0 * * * *` | top of every hour |
| `gmail-reply-checkup` | `0 5 * * * *` | five minutes after each hour |

launchd has no native 6-field-cron concept, so `bin/pi-personal-schedule-sync` translates the
`min`/`hour` fields into a `StartCalendarInterval {Minute, Hour}` — the original cron string is
preserved verbatim as a `PiFleetCronOriginal` metadata key in the installed plist (launchd ignores
unknown keys) so the exact source string stays auditable.

## How sync works (`bin/pi-personal-schedule-sync`)

Run automatically by `bin/pi-personal-assistant` on every invocation (non-fatal on failure - a
broken sync must not block getting into a session). For each enabled schedule:

1. Compute the desired `~/Library/LaunchAgents/dev.pi-fleet.personal.<name>.plist` content.
2. Use `PI_FLEET_REPO_ROOT` or the stable `~/code/pi-fleet` runner when available rather than
   capturing a disposable feature-worktree path. `PI_FLEET_HOME` is reserved for runtime state.
3. Preserve the validated sync-time `PATH` in `EnvironmentVariables`, because launchd does not
   inherit the interactive shell environment and otherwise may fail to find `outfitter` (status 127).
4. Write changed plist content atomically, then always `launchctl bootout` + `launchctl bootstrap`.
   Reloading unchanged jobs repairs unloaded or previously failed jobs without creating duplicates.

The wrapper marks sync with `PI_FLEET_PROFILE=personal-assistant`; an explicitly different profile
is rejected. Direct manual sync remains supported when the marker is unset. Set
`PI_SCHEDULE_SYNC_ENABLED=0` to unload and remove the personal LaunchAgents without editing JSON.
Testing/isolation overrides: `PI_SCHEDULE_SYNC_AGENTS_DIR`, `PI_SCHEDULE_SYNC_LOG_DIR`,
`PI_SCHEDULE_SYNC_LOG_MAX_BYTES`, `PI_SCHEDULE_SYNC_SCHEDULES_JSON`,
`PI_SCHEDULE_SYNC_RUNNER`, and
`PI_SCHEDULE_SYNC_DRY_RUN=1` (writes/diffs plists, skips real `launchctl` calls).

## How a fire works (`bin/pi-personal-schedule-run <name>`)

launchd invokes this at the scheduled time. It reads the schedule's definition from
`schedules.json`, builds the full prompt (roster + banned-provider constraints, the exact
commands to run first, hard no-mutation constraints, output format/word cap, `[ACTION]`
escalation instructions, and the current task ID if one is on file), and runs it one-shot via
`bin/pi-personal-assistant -p "<prompt>"`.

## Constraints encoded in every fired prompt

- Roster: prefer `openai-codex`/`gpt-5.5`. Never Kimi/GLM/Gemini/Grok/xai.
- `social-x-checkup`: read-only Finch; **no X mutations** (no post/reply/like/repost/follow/delete).
- `gmail-reply-checkup`: read-only GOG Gmail (`--readonly --gmail-no-send`); **no Gmail mutations**
  (no send/reply/draft/archive/mark-read/label/trash/delete); ignore newsletters/promos/receipts
  unless clearly action-needed.
- Output: under ~200 words, source-labeled (`[X]` / `[Gmail]`), reply-needed/broken-dependency
  items labeled `[ACTION]` and escalated to pi-conductor/conductor.
- Task IDs (`task_mrf1w80u_35rnjv`, `task_mrfx9f64_hxq4nu`) are passed through as optional context,
  not hard-coded as the only valid IDs — schedules keep working if those IDs go stale.

## Logs

`~/.pi-fleet/logs/personal/<name>.log` (stdout) and `<name>.error.log` (stderr). Logs are private and rotate at 5 MiB with three generations.
