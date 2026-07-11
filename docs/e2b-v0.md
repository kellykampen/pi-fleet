Planning and design for E2B remote workers v0 live in Linear: project (see docs/e2b-v0.md) / design doc (see docs/e2b-v0.md).

## Tools (project-lead)

- `e2b_cast(profile, brief, codeAccess, repo, ...)` — start an async job; returns `jobId`.
- `e2b_status(jobId)` — read a job's current status, probing the sandbox if running.
- `e2b_wait(jobId, timeoutMinutes?, pollSeconds?)` — block until the job reaches a terminal status.
- `e2b_cancel(jobId)` — kill the sandbox (if any) and mark the job cancelled.
- `e2b_logs(jobId)` — tail the job's latest logs.
- `e2b_port_url(jobId|sandboxId, port)` — return the public URL for a port on a running sandbox.
  Takes either a fleet `jobId` or a raw E2B `sandboxId`. Errors clearly if the sandbox isn't
  running (unknown/dry-run/terminal job, or the sandbox itself reports not running) or if the
  port has no listener (the E2B edge proxy returns 502/503 for a closed port).
