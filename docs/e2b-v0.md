# E2B remote workers — v0 design

Status: **accepted design; implementer-remote path in progress.**

Hierarchy reminder:

```
CEO → conductor → project lead → worker
```

E2B is an **execution backend for a cast**, chosen by the **project lead**. It is not portfolio routing.

---

## Goals (v0)

- Project lead can cast an **implementer** into an [E2B](https://e2b.dev) sandbox.
- Cast is **async** (returns `jobId`); optional **wait**.
- Worker produces a **structured job result** (authoritative for tools) and, for implementers, a **PR + evidence** on GitHub.
- **No local worktree** for E2B casts.
- Job records live **locally** (`~/.pi/fleet/jobs/`); later the same schema moves to **Convex + small UI**.

Non-goals for v0: remote reviewer/AC-verify/visual-qa, live steer, soft $ budgets, GitHub App identity, multi-machine job store.

---

## Decisions

| Topic | Choice |
|---|---|
| Who may spawn E2B | **Project lead only** — tools allowlisted on `pi-project-lead` only |
| Cast style | **Async** + `e2b_wait(jobId)` |
| Report back | **Structured JSON always**; GitHub/Linear **by worker role** |
| Code access | Per cast: `none` \| `clone` \| `pr` \| `branch` |
| Job store | Local v0 → Convex later (stable tool API) |
| v0 worker | **Implementer only** |
| GitHub auth | Short-lived / per-job token (fine-grained PAT path) → GitHub App next |
| Model keys | Dedicated **fleet-worker** provider keys (not CEO laptop keys) |
| Packaging | In-tree `extensions/e2b/` (extract package later) |
| Bootstrap | Hybrid: E2B **template** has toolchain + pi; job **pins/pulls** pi-fleet |
| Local worktree | **None** for E2B casts |
| Stuck worker | Terminal `needs_input` + re-cast (no live steer) |
| Guardrails | Hard timeout (default **90 minutes**), `e2b_cancel` |

---

## Tools (project-lead allowlist)

| Tool | Purpose |
|---|---|
| `e2b_cast` | Start async remote job; returns `jobId` |
| `e2b_status` | Read job record (+ sandbox probe) |
| `e2b_wait` | Block until terminal status or timeout |
| `e2b_cancel` | Kill sandbox; mark job cancelled |
| `e2b_logs` | Tail recent sandbox / job logs |

Only `bin/pi-project-lead` includes these tools. Conductor and workers must not.

---

## Job contract

### Cast input (v0 implementer)

```ts
{
  profile: "implementer",          // v0: only implementer
  provider?: string,               // model override
  model?: string,
  ticketId?: string,               // Linear id e.g. ENG-123
  brief: string,                   // full worker brief
  codeAccess: "clone" | "pr" | "branch",  // implementer needs code
  repo: string,                    // owner/name or https URL
  baseBranch?: string,             // for clone; default main/master
  prNumber?: number,               // for codeAccess=pr
  branch?: string,                 // for codeAccess=branch
  timeoutMinutes?: number,         // default 90
  fleetRef?: string,               // pi-fleet git ref to pin in sandbox
  dryRun?: boolean                 // no E2B; write local job only
}
```

### Structured result (authoritative)

```ts
{
  jobId: string,
  profile: "implementer",
  status: "queued" | "running" | "succeeded" | "failed" | "timeout" | "cancelled" | "needs_input",
  ticketId?: string,
  commitSha?: string,
  prUrl?: string,
  branch?: string,
  commandsRun?: { cmd: string; exit: number; logRef?: string }[],
  blockers?: string[],
  questions?: string[],            // when needs_input
  artifacts?: string[],
  error?: string,
  sandboxId?: string,
  createdAt: string,
  updatedAt: string,
  finishedAt?: string
}
```

### Role-dependent side channels

| Worker | Structured result | GitHub / Linear |
|---|---|---|
| implementer | required | PR + gate evidence (usual) |
| reviewer / security (later) | required | PR review comments (usual) |
| researcher (later) | required | optional |

---

## Runtime flow (implementer)

```
project lead
  e2b_cast({ profile: implementer, codeAccess: clone, repo, brief, ... })
       │
       ├─ write ~/.pi/fleet/jobs/<jobId>.json  (status=queued)
       ├─ mint/inject short-lived GitHub token (env; never log)
       ├─ inject fleet-worker model keys (env; never log)
       ├─ Sandbox.create(template, timeout)
       ├─ pull/pin pi-fleet @ fleetRef
       ├─ clone / pr checkout per codeAccess
       ├─ run pi-implementer -p "<brief>" (non-interactive)
       └─ worker writes result.json + opens PR
              │
project lead
  e2b_status / e2b_wait  →  merge sandbox result into local job record
```

On hard timeout: kill sandbox, `status=timeout`.  
On ambiguity: worker exits `needs_input` with `questions[]`.

---

## Secrets & setup

See [README — E2B remote implementers](../README.md#e2b-remote-implementers-v0) for env vars and GitHub token scopes.

Summary:

| Secret | Where | Purpose |
|---|---|---|
| `E2B_API_KEY` | project-lead machine | Create/connect sandboxes |
| `FLEET_GITHUB_TOKEN` | injected per job | Clone private repos, push branch, open PR |
| Fleet model keys | injected per job | Provider calls inside sandbox (`OPENAI_*` / `OPENROUTER_API_KEY` / etc. as **worker** keys) |

Never forward the CEO’s personal ssh-agent or unrestricted PATs into the sandbox.

---

## Local job store (v0)

- Directory: `~/.pi/fleet/jobs/`
- One JSON file per `jobId`
- Tools never require Convex; a later store implements the same read/write interface

---

## Evolution

1. **v0.1** — `codeAccess: pr` for remote reviewer / ac-verifier  
2. **GitHub App** — replace fine-grained PAT minting  
3. **Convex** — same job schema + small UI  
4. **Extract** `extensions/e2b` → installable pi package if reused outside this fleet  

---

## Open implementation notes

- Outfitter + absolute skill paths must be resolved inside the sandbox (pin pi-fleet; rewrite or package profiles).
- Custom E2B template ID should be configurable (`FLEET_E2B_TEMPLATE` / settings).
- `e2b_wait` should poll local job file + sandbox result path, not block a single long RPC without heartbeat updates to the job record.
