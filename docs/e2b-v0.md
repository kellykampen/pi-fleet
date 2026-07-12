Planning and design for E2B remote workers v0 live in Linear: project (see docs/e2b-v0.md) / design doc (see docs/e2b-v0.md).

Two worker profiles share this lifecycle:
- `implementer` — clone/branch/PR, may push and open a PR (FLT-4 and this doc).
- `reviewer` — read-only review of an *existing* PR; fetches the diff, posts
  findings as a PR comment, never mutates code. See `docs/e2b-reviewer.md`
  (FLT-45) for its params, credential scoping, and result shape.

## Tools (project-lead)

- `e2b_cast(profile, brief, codeAccess, repo, ...)` — start an async job; returns `jobId`.
  While the job runs, a keepalive re-extends the sandbox's own timeout by `timeoutMinutes`
  (default 90) on an interval, so the sandbox doesn't die just because a job is taking a
  while. Each extension stamps the job's `lastExtendedAt`. The keepalive stops as soon as
  the job reaches a terminal status (succeeded/failed/timeout/cancelled) or `maxLifetimeMinutes`
  (default 180 — 3h) is reached, whichever comes first; `maxLifetimeMinutes` bounds total job
  lifetime independent of how many times the sandbox has been extended.
- `e2b_status(jobId?, sandboxId?)` — read a job's current status, probing the sandbox if running. Pass a raw `sandboxId` to reconnect after losing the local job record; the live result/log data rehydrates a local record where possible.
- `e2b_wait(jobId, timeoutMinutes?, pollSeconds?)` — block until the job reaches a terminal status.
- `e2b_cancel(jobId)` — kill the sandbox (if any) and mark the job cancelled.
- `e2b_logs(jobId?, sandboxId?)` — tail the job's latest logs. Like status, it accepts a raw `sandboxId` and reconnects without requiring a local record.
- `e2b_port_url(jobId|sandboxId, port)` — return the public URL for a port on a running sandbox.
  Takes either a fleet `jobId` or a raw E2B `sandboxId`. Errors clearly if the sandbox isn't
  running (unknown/dry-run/terminal job, or the sandbox itself reports not running) or if the
  port has no listener (the E2B edge proxy returns 502/503 for a closed port).

### Reconnect an existing sandbox

If a project-lead session or local job store is lost while the E2B sandbox is still running, use the sandbox ID directly:

```text
e2b_status({ sandboxId: "<e2b-sandbox-id>" })
e2b_logs({ sandboxId: "<e2b-sandbox-id>" })
```

The first call attaches to the live sandbox, reads `/work/result.json`, `/work/job.log`, and `/work/brief.md` when available, and persists a reconstructed fleet job. The original remote `jobId` is restored from the result or log where possible; otherwise the sandbox ID becomes the local `jobId`. Subsequent calls may use that returned `jobId`.
