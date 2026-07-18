# E2B fleet job store — Convex support + jobs UI (FLT-7)

Follow-up to the E2B v0 local job store. This moves the job store toward Convex
**without changing the public e2b tool API**. The local `~/.pi-fleet/state/e2b/jobs/`
store remains the default and fallback.

Linear: <https://linear.app/dojoco/issue/FLT-7>

## Store selection

The e2b tools (`e2b_cast`, `e2b_status`, `e2b_wait`, `e2b_cancel`, `e2b_logs`)
call the same four verbs in `jobs.ts` — `writeJob` / `readJob` / `updateJob` /
`listJobs`. Those verbs now delegate to a selected `JobStore`:

| Condition                    | Store used                          |
| ---------------------------- | ----------------------------------- |
| `FLEET_CONVEX_URL` **unset** | `localStore` (filesystem, default)  |
| `FLEET_CONVEX_URL` **set**   | `ConvexJobStore` (Convex HTTP API)  |

Selection is evaluated per call (`getJobStore()` in `jobs.ts`), so nothing needs
restarting when the env changes. Secret sanitization and the `updatedAt` /
terminal-`finishedAt` bookkeeping stay in the `jobs.ts` verbs, so both stores get
identical business logic — a store is pure persistence (`put`/`get`/`list`).

### Environment

| Variable             | Purpose                                                      |
| -------------------- | ------------------------------------------------------------ |
| `PI_FLEET_HOME`      | Absolute runtime-root override; local jobs stay beneath it.  |
| `FLEET_CONVEX_URL`   | Convex deployment URL, e.g. `https://acme-123.convex.cloud`. |
| `FLEET_CONVEX_TOKEN` | Optional bearer token for an authed deployment.             |

## Convex side

`ConvexJobStore` (`convexStore.ts`) talks to Convex over its public HTTP API
(`POST /api/query`, `POST /api/mutation`), so the client needs **no `convex` npm
dependency** and is trivially mockable (tests inject `fetchImpl`). It calls three
server functions:

- `jobs:put`  — mutation, upsert by `jobId`
- `jobs:get`  — query, by `jobId`
- `jobs:list` — query, filter by `status` / `repo` / `ticketId`

The matching server code lives in `extensions/e2b/convex/`:

- `convex/schema.ts` — the `jobs` table. Every column mirrors `FleetJob` in
  `types.ts` one-to-one (the shared `jobFields` object), so the stored document
  **is** the e2b tool contract. Indexes: `by_jobId`, `by_status`, `by_repo`,
  `by_ticket`.
- `convex/jobs.ts` — the `put`/`get`/`list` functions. `list` reads through the
  most selective index available (`by_repo` > `by_ticket` > `by_status` for a
  single status > full table), ordered newest-first (`order("desc")`), and
  filters the rest in JS, bounded by `MAX_JOBS = 1000`.

Convex adds `_id` / `_creationTime` system fields to every document;
`ConvexJobStore` strips them so callers always get a clean `FleetJob`.
`ConvexJobStore` also bounds every HTTP call with a 15s deadline
(`timeoutMs`, configurable) so a hung deployment surfaces a clear timeout
error instead of hanging the calling e2b tool indefinitely.

### Known v0 limits (not addressed by this follow-up)

- **No `ctx.auth` check** on `put`/`get`/`list` — this deployment relies on
  `FLEET_CONVEX_TOKEN` being kept private, not on Convex-side identity
  verification. Adding real auth means wiring a Convex Auth provider, which is
  bigger than this job-store/UI follow-up; tracked as a future ticket if this
  ever needs to run on a shared/exposed deployment.
- **`MAX_JOBS = 1000` is a hard cap, not paginated.** Past that many rows in
  the table, `list` still only sees its newest 1000 (now ordered correctly —
  see below) and filters within that window. Full cursor-based pagination
  would be needed to search the entire table past the cap.

### Deploying (only needed for real Convex use)

The `convex/` files are standard Convex code but are **not** part of this
extension's build or tests (the client is HTTP-only). To run them against a real
deployment:

```bash
cd extensions/e2b
npm i -D convex
npx convex dev      # or: npx convex deploy
export FLEET_CONVEX_URL="https://<your-deployment>.convex.cloud"
```

No real deployment is required for CI: the store is validated with a mocked
`fetch` (see `convexStore.test.ts`).

## Jobs UI

`jobs-ui.ts` lists jobs from the **selected** store (local or Convex) filtered by
status / project / ticketId, as a terminal table or a self-contained HTML page.

```bash
cd extensions/e2b
npm run jobs -- --status running --project acme/web --ticket FLT-7
npm run jobs -- --html > jobs.html
```

Flags: `--status <s>`, `--project <owner/name>`, `--ticket <id>`, `--html`.
`--status` is validated against the known `JobStatus` values; an unknown flag
or a flag missing its value fails fast with a clear error instead of being
silently ignored or swallowing the next argument.

The `renderJobsText` / `renderJobsHtml` renderers are pure and unit-tested; HTML
output escapes all values (XSS-safe), and the terminal table sanitizes control
characters (newlines, tabs, ANSI escapes) out of every cell so a job field
can't break column alignment or inject terminal escape sequences.

## Tests

```bash
cd extensions/e2b && npm install && npm test
```

- `jobs.test.ts` — local store fallback: `listJobs` filtering by
  status/repo/ticketId, terminal `finishedAt` stamping.
- `convexStore.test.ts` — Convex client with a mocked `fetch`: endpoint/body
  shape, bearer auth, system-field stripping, error surfacing, store selection.
- `jobs-ui.test.ts` — pure renderers + flag parsing.

Existing `cast.test.ts` / `secrets.test.ts` continue to pass (local store
behavior unchanged).
