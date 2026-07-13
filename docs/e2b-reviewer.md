# E2B reviewer casts (FLT-45)

A `profile: "reviewer"` cast is a **read-only** counterpart to the implementer
cast path (`docs/e2b-v0.md`, FLT-4). It reviews an *existing* pull request and
posts its findings as a PR comment. It never clones a working tree, never
pushes, never commits, and never opens or merges a PR.

## What it does

1. `e2b_cast({ profile: "reviewer", repo, prNumber, brief, codeAccess: "pr" })`
   starts a sandbox that:
   - fetches the PR's metadata (`gh pr view`) and diff (`gh pr diff`) —
     read-only, no clone/checkout of the target repo
   - hands both to `pi-reviewer` (see `bin/pi-reviewer` and
     `profiles/reviewer/profile.yml` — unchanged by FLT-45), which runs with
     **no write/edit/bash tools**, so it structurally cannot mutate anything
   - posts pi-reviewer's findings as a plain PR **comment**
     (`gh pr comment`) — never a formal `gh pr review --approve` /
     `--request-changes`, which carries merge-blocking authority a bot
     shouldn't hold on its own; a human stays the actual merge decision-maker
2. The job's terminal `result.json` (and the `FleetJob` record) carries:
   - `verdict`: `"APPROVE" | "REQUEST-CHANGES" | "UNKNOWN"`
   - `findingsSummary`: the reviewer's findings text (as posted)
   - `reviewUrl`: the URL of the posted PR comment
   - `readOnlyEvidence`: the exact `gh pr view`/`gh pr diff`/`gh pr comment`
     invocations the sandbox ran — proof of the read-only guarantee, not just
     an assertion of it

## Example

```text
e2b_cast({
  profile: "reviewer",
  repo: "owner/repo",
  codeAccess: "pr",
  prNumber: 128,
  brief: "Focus on auth and input validation; flag anything that touches the session cookie handling.",
})
```

Returns a `jobId` immediately, same as an implementer cast. Poll it with the
same generic tools:

```text
e2b_status({ jobId })
e2b_wait({ jobId })
e2b_logs({ jobId })
e2b_cancel({ jobId })
```

None of those tools branch on profile — they already worked generically by
`jobId`/`sandboxId` before FLT-45, and reviewer jobs use them unchanged. The
same is true of reconnect-by-`sandboxId` (`docs/e2b-v0.md` § Reconnect); a lost
reviewer job's `profile`, `verdict`, `findingsSummary`, `reviewUrl`, and
`readOnlyEvidence` all rehydrate from the sandbox's `result.json` exactly like
`commitSha`/`prUrl` do for a lost implementer job.

## Credentials — scoped separately from the implementer's push token

Reviewer casts resolve their GitHub token through a **different**
precedence order than implementer casts:

| Profile | Token precedence |
|---|---|
| `implementer` | `FLEET_GITHUB_TOKEN` → `GH_TOKEN` |
| `reviewer` | `FLEET_GITHUB_REVIEWER_TOKEN` → `FLEET_GITHUB_TOKEN` → `GH_TOKEN` |

Set `FLEET_GITHUB_REVIEWER_TOKEN` to a token scoped to **"Pull requests:
write, Contents: read"** only (no `Contents: write`, no ability to push) to
keep reviewer credentials genuinely separate from the implementer's
push/PR-open token. If unset, a reviewer cast falls back to the implementer's
token so it works with zero extra setup — but note that this means the
read-only guarantee then rests entirely on the runner script never issuing a
mutating command (see `buildReviewerRunnerScript` in `extensions/e2b/secrets.ts`),
not on token scope. Scoping `FLEET_GITHUB_REVIEWER_TOKEN` down is
defense-in-depth on top of that, not a substitute for it.

The resolved token is shipped into the sandbox under the same
`FLEET_GITHUB_TOKEN` env var name the runner script reads, regardless of which
of the three env vars supplied it — the remote script never needs to know
which one the operator configured.

## Model/provider auth

`profiles/reviewer/profile.yml` defaults to `provider: openai-codex`, which pi
authenticates via **OAuth**, not an API key — the same requirement the
implementer profile already has (see `PI_AGENT_AUTH_JSON_B64` in
`docs/e2b-v0.md`/README). A reviewer cast has exactly two ways to succeed:

1. **Forward the OAuth blob** — export `PI_AGENT_AUTH_JSON_B64` (base64 of
   your local `~/.pi/agent/auth.json`) before casting, same as implementer
   casts already require. This keeps the profile's default (openai-codex /
   gpt-5.5).
2. **Override `provider`/`model` together**, pointing at a provider
   authenticated via one of the already-forwarded `FLEET_WORKER_MODEL_KEYS`
   (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, etc.) — e.g.
   `e2b_cast({ ..., provider: "anthropic", model: "<a valid anthropic model id>" })`.

`e2b_cast` **requires `provider` and `model` to be set together** for a
reviewer cast — passing only one throws a validation error before a sandbox
is even created. This is deliberate: a partial override (e.g. `model` alone)
risks pairing an overridden model with the profile's *default* provider (or
vice versa), and an invalid provider+model pairing can be silently dropped
rather than erroring, which is indistinguishable from "the override did
nothing" — exactly what a live run against this profile showed (jobs
`ab043369`, `9e9c2a4f`: requested `model: gpt-5.6-sol` without an explicit
provider override; the terminal job still reported the profile's default
`model=gpt-5.5` and then failed with `No API key found for openai-codex`).

If neither of the two options above is available, `e2b_cast` now fails
**immediately, before creating a sandbox**, with a clear error naming both
paths — rather than burning a sandbox and failing deep inside pi's launch
two-plus minutes later with an opaque `No API key found for openai-codex`.

**Known limitation:** this fleet's `outfitter`/`pi` CLI wrapper chain
(`bin/pi-reviewer` → `lib/pi-model-env.sh` → `outfitter run --profile
reviewer --agent pi -- ...`) forwards a `provider`/`model` override to `pi`
itself as trailing CLI flags, identically to how `bin/pi-implementer` already
does it — this PR did not change that forwarding mechanism, since it's shared
infrastructure outside `extensions/e2b`'s scope and outfitter/pi aren't
runnable from this development environment to verify their exact override
precedence empirically. If a live run with a *matched* provider+model pair
still shows the override not taking effect, that points at `outfitter`/`pi`
itself (or an invalid model id for the chosen provider), not at the E2B
runner script — file that against the wrapper/outfitter, not this extension.

## Why a comment, not a formal review

`gh pr review --approve`/`--request-changes` creates a review event that can
gate merging (e.g. required-reviews branch protection). An AI reviewer posting
one of those on its own would be delegating real merge authority to a cast. A
plain PR comment carries the same findings without that authority — the
project lead (or a human reviewer) still decides.

## Validation status (as of this PR)

`cd extensions/e2b && npx tsx --test *.test.ts` covers: reviewer cast param
validation (including the paired provider/model override rule above), `castJob`
dispatch for `profile: "reviewer"`, token-precedence resolution, the
fail-fast model-auth preflight, the generated runner script (asserts the
read-only gh calls are present and no code-mutating command — `git
push`/`git commit`/`git checkout`/`gh repo clone`/`gh pr merge`/`gh pr
review` — ever appears, and that it `cd`s into a `/work` subdirectory before
invoking `pi-reviewer` so `profile.yml`'s `../extensions/linear.ts`
resolves), the reviewer result finalizer (succeeded / PR-fetch-failed /
comment-post-failed / reviewer-process-failed paths), and
`reconnectSandbox`/`refreshFromSandbox` carrying the reviewer-only result
fields.

Live E2B runs against this PR (by the project lead, with real credentials)
found and fixed two sandbox-only bugs this test suite couldn't catch without
running the real `outfitter`/`pi` stack:
1. A missing `cd` before invoking `pi-reviewer` broke `profile.yml`'s
   extension resolution (`Failed to load extension /extensions/linear.ts`) —
   fixed in `d5c2813`.
2. No model/provider auth path was available in those runs, and a partial
   model override was silently dropped rather than erroring — addressed
   above (fail-fast preflight + paired-override validation). This part is
   a defensive fix at the E2B-extension boundary, not a verified fix of
   `outfitter`/`pi`'s own override precedence (see "Known limitation" above)
   — a live run with `PI_AGENT_AUTH_JSON_B64` set, or a valid paired
   provider+model override, is still needed to confirm end-to-end success.

A real remote reviewer cast against an actual PR, producing an actual posted
comment, remains an open gate before this ticket's
AC ("Independent review + AC verification with a real remote PR-review run
before Done") can be marked satisfied — see the PR description for the exact
command to run once credentials are available.
