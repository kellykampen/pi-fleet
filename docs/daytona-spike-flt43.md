# FLT-43 — Spike: Daytona as a fleet compute-offload backend

**Status:** spike complete (research + local SDK proof). **Recommendation: defer.**
**Scope guard:** evaluation only — no production Daytona backend was built, E2B is
unchanged, and no `profiles/*` were touched. The only wiring is the scratch script
under `spike/daytona-flt43/`.

## 1. What the fleet's E2B integration actually does (surfaces to match)

Mapped from `extensions/e2b/*` (see `docs/e2b-v0.md`). A Daytona backend would have
to reproduce every surface below; the store layer is already backend-agnostic.

| Surface | Where (E2B) | What it needs |
| --- | --- | --- |
| **Cast flow** | `cast.ts` `tryCreateSandbox` | create sandbox from a prebuilt template → `chmod /work` → upload source archive (`codeAccess=clone`) + `run-job.sh` → background it via `nohup … & echo $! > job.pid` |
| **Secrets** | `secrets.ts` `collectWorkerEnv` | GitHub token (App-minted `ghs_` or PAT), `FLEET_WORKER_MODEL_KEYS`, `PI_AGENT_AUTH_JSON_B64`. Injected **only as the exec's env at launch**, never baked into the image, never persisted, sanitized out of logs (`sanitizeSecrets`) |
| **Jobs / state** | `jobs.ts`, `types.ts` `FleetJob` | `queued→running→{succeeded,failed,timeout,cancelled,needs_input}`; local FS store or Convex store, keyed by `jobId`; `sandboxId` is just a string field |
| **Ports / preview URL** | `ports.ts` `resolvePortUrl` | `sandbox.getHost(port)` + HEAD probe (502/503 ⇒ "no listener") |
| **Reconnect / logs** | `cast.ts` `reconnectSandbox`/`refreshFromSandbox` | reattach by raw `sandboxId`, read `/work/result.json` + `/work/job.log` + `/work/brief.md`, rehydrate a lost job record |
| **Keepalive / lifetime** | `cast.ts` keepalive loop | re-extend the sandbox's own TTL every 20 min (`setTimeout(ms)`), bounded by `maxLifetimeMinutes` (180) |
| **Convex job-state layer** | `convexStore.ts`, `convex/` | pure HTTP `jobs:put/get/list`; **provider-agnostic — unaffected by a backend swap** |

## 2. Daytona: what it is (verified)

- **Product:** cloud platform for running AI-generated code in isolated sandboxes
  (dedicated kernel/fs/network, sub-100ms start). Primitives: **sandboxes, snapshots,
  volumes, sessions, preview links**.
- **SDKs:** official TypeScript `@daytona/sdk` (published as `@daytonaio/sdk`
  v0.196.0, released 2026-07-10 — **weekly release cadence**), plus Python/Go/Ruby/Java.
  Repo `daytona/clients` (SDKs + CLI + **MCP server**), pushed 2026-07-12.
- **⚠️ Open-source engine is frozen.** `daytonaio/daytona` README (verified via
  `gh api`): *"This repository is no longer maintained. As of June 2026, Daytona's
  core development has moved to a private codebase. This repository will receive no
  further updates, fixes, or releases."* The **cloud service and its SDK stay very
  active** — so Daytona is now effectively a **proprietary cloud-only** offering;
  self-hosting the open engine is a dead end.
- **No official "Daytona Pi extension"** exists. `github.com/daytona/integrations`
  and `daytonaio/integrations` both 404; the only agent surface is the official
  **MCP server** in `daytona/clients`. The brief's `richardanaya/pi-daytona` was
  (as instructed) ignored. A pi-fleet integration would be **built directly on the
  SDK**, exactly like the E2B extension is.

## 3. API-shape mapping — E2B → Daytona SDK (all verified against installed `.d.ts`)

| Step | E2B (`e2b` ^2.32) | Daytona (`@daytonaio/sdk` 0.196) |
| --- | --- | --- |
| create | `Sandbox.create(template,{timeoutMs,apiKey})` | `daytona.create({image\|snapshot, envVars, resources, autoStopInterval, public, networkBlockAll},{timeout, onSnapshotCreateLogs})` |
| connect/reconnect | `Sandbox.connect(id,{apiKey})` | `daytona.get(idOrName)` |
| write file | `sandbox.files.write(path,content)` | `sandbox.fs.uploadFile(buf\|localPath, remotePath)` |
| read file | `sandbox.files.read(path)` | `sandbox.fs.downloadFile(remotePath) → Buffer` |
| run command | `sandbox.commands.run(cmd,{timeoutMs,user,envs})` | `sandbox.process.executeCommand(cmd,cwd,env,timeout)` |
| background job | `nohup … & echo $! > pid` | first-class **sessions**: `createSession`/`executeSessionCommand` + streaming `getSessionCommandLogs` |
| port URL | `sandbox.getHost(port)` + probe | `sandbox.getPreviewLink(port) → {url,token}`; also `getSignedPreviewUrl(port,ttl)` |
| keepalive/TTL | `sandbox.setTimeout(ms)` (absolute) | `sandbox.setAutostopInterval(min)` (**inactivity**) + `refreshActivity()`; `autoArchive`/`autoDelete` too |
| running? | `sandbox.isRunning()` | `sandbox.state` / `refreshData()` / `waitUntilStarted()` |
| secrets | env at exec | `envVars` at create, per-exec `env`, `updateSecrets()`, **org-level Secrets store** |
| kill | `sandbox.kill()` | `sandbox.delete()` (or `stop()`/`pause()` to keep filesystem) |

## 4. Local / SDK proof (no `DAYTONA_API_KEY`)

`DAYTONA_API_KEY` is **not set** in this lead environment — independently verified
(`printenv DAYTONA_API_KEY` → empty; no `.env*` files; no `DAYTONA_*` anywhere in the
repo). Per the brief, no live proof was faked. Closest proof achieved
(`spike/daytona-flt43/spike-cast.mjs`, reproduces steps 1–5 above):

- **SDK installs & imports cleanly under plain Node** (`Daytona`/`DaytonaError` are
  functions). *Caveat:* the E2B extension needs a `createRequire` shim
  (`extensions/e2b/sdk.ts`) because e2b's esbuild-CJS interop crashes under pi's jiti
  loader. Whether `@daytonaio/sdk` trips the same jiti/CJS-ESM interop is **untested
  here** (it ships both ESM and CJS builds) and must be checked before any real wiring.
- **Exact credential blocker** (the documented, expected outcome):

  ```
  DaytonaAuthenticationError: Authentication credentials not found.
  Set DAYTONA_API_KEY, or both DAYTONA_JWT_TOKEN and DAYTONA_ORGANIZATION_ID.
  ```

  Thrown at `new Daytona()` — auth is validated at client construction, before any
  sandbox is billed. To finish the live end-to-end cast, set `DAYTONA_API_KEY` (free
  tier includes $200 credit) and re-run the script.

## 5. Cost / ops

- **Daytona (public docs, 2026):** ≈ **$0.0504 / vCPU-hour**, ≈ **$0.0162 / GiB-hour**,
  **billed per second**, pay only while running. Default sandbox 1 vCPU / 1 GB / 3 GiB;
  org cap 4 vCPU / 8 GB / 10 GB. **$200 free credit.** Stopped sandboxes stop billing
  compute (auto-archive after inactivity). Sources: daytona.io/pricing; ZenML & Northflank comparisons.
- **E2B (current):** also usage-based per-second; exact per-vCPU rate **not re-verified
  in this spike** — confirm against the live E2B invoice before any cost decision.
- **Ops delta vs E2B:** Daytona **removes the template-publish pipeline**
  (`template/*.Dockerfile` + `@e2b/cli`) — takes a plain Docker image string or a
  declarative `Image.base(…).pipInstall(…)`, or a named snapshot. That also **removes
  the whole class of opaque `envd "version"` template/CLI-mismatch failures**
  (`SANDBOX_VERSION_ERROR_HINT`). Trade-off: building an image on first cast adds
  cold-start latency unless a snapshot is pre-created.

## 6. Security / secrets model

Daytona is **at least as strong** as the current E2B model, arguably stronger:
- API-key auth (`DAYTONA_API_KEY`) or JWT+org-id; validated at construction.
- **Private sandboxes** (`public:false`) → preview links require a token;
  `getSignedPreviewUrl(port, ttl)` gives expiring signed URLs. E2B's `getHost` is a
  public proxy guarded only by an unguessable host.
- `networkBlockAll`, time-boxed SSH (`createSshAccess(expiresInMinutes)`), and an
  org-level Secrets store.
- The fleet's core invariant — **inject secrets as the per-exec env, never bake into
  the image, never persist** — maps directly onto `process.executeCommand(cmd,cwd,env)`.
  *Must verify:* that create-time `envVars` are **not** captured into auto-created
  snapshots (leak risk) — prefer per-exec `env` + `updateSecrets`, as the spike script does.

## 7. Gaps vs current E2B integration

1. **No drop-in extension** — a full `extensions/daytona/` (cast/secrets/ports/reconnect/
   keepalive) must be written; only the Convex store ports for free.
2. **jiti/CJS load path untested** under pi's extension loader (§4 caveat).
3. **Timeout semantics differ** — E2B absolute-TTL keepalive vs Daytona
   inactivity-auto-stop; the keepalive loop maps to `refreshActivity()` but
   `maxLifetimeMinutes` still needs its own ceiling timer.
4. **Reconnect divergence** — Daytona auto-stop **pauses** (filesystem persists,
   restartable) where E2B kills; the `result.json`/`job.log` rehydration contract
   would need porting and re-testing.
5. **No live E2E proof** — blocked on `DAYTONA_API_KEY` (§4).
6. **Vendor risk** — OSS engine frozen ⇒ cloud lock-in with no self-host escape hatch (§2).

## 8. Recommendation — **defer**

Daytona is a credible, well-fit backend: the SDK covers every surface the fleet needs,
its security model is stronger, and it deletes E2B's template-publish friction. But
**nothing here is urgent or broken** — E2B works today — and the two blockers that
would decide a real bake-off are unresolved: **no `DAYTONA_API_KEY`** (so no live E2E)
and **cloud-only lock-in** now that the OSS engine is frozen. Building a parallel
prototype now spends real effort against an unproven migration with no pressing driver.

**Defer** until there is a concrete trigger (an E2B cost/reliability problem, or a need
for Daytona's snapshot/persistence model). When triggered, the cheap next move is a
**time-boxed live E2E**: provision one `DAYTONA_API_KEY`, run `spike/daytona-flt43/
spike-cast.mjs` to green, and confirm the jiti-load path — a few hours that turn this
static proof into a real go/no-go, without committing to a full parallel backend.

## Appendix — reproduce

```bash
cd spike/daytona-flt43
npm init -y >/dev/null && npm i @daytonaio/sdk
node spike-cast.mjs                       # DaytonaAuthenticationError (expected, no key)
DAYTONA_API_KEY=<key> node spike-cast.mjs  # live end-to-end cast
```

Evidence gathered 2026-07-13 against `@daytonaio/sdk` 0.196.0. GitHub facts via
`gh api`; pricing via public docs/comparisons (see §5).
