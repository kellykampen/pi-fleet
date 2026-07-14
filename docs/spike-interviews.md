# Spike interviews

`spike-breakdown` uses [`agent-interview-cli`](https://github.com/nicobailon/agent-interview-cli)
as its primary CEO interview channel. The CLI opens a localhost form directly in the browser and
returns structured responses to the spike seat. No intermediary session relays questions or answers.

## Reproducible installation

The runtime is repo-local and least-privilege:

- [`tools/agent-interview-cli/package.json`](../tools/agent-interview-cli/package.json) pins the exact
  runtime dependency `agent-interview-cli@0.1.0`;
- [`tools/agent-interview-cli/package-lock.json`](../tools/agent-interview-cli/package-lock.json)
  pins the npm tarball URL and integrity digest;
- install scripts are disabled, and only production dependencies are installed;
- [`bin/pi-fleet-spike-interview`](../bin/pi-fleet-spike-interview) executes only that clone-local
  binary and verifies `--version` before browser launch.

Install all fleet dependencies:

```bash
./setup.sh
```

Or install only this pinned runtime:

```bash
npm ci --prefix tools/agent-interview-cli --omit=dev --ignore-scripts
```

Verify without changing the machine:

```bash
./setup.sh --check
```

A global npm install or floating `npx agent-interview-cli` is not part of this flow.

## Invocation

The spike seat creates its question JSON in `/tmp`, then runs:

```bash
pi-fleet-spike-interview run \
  --issue SPIKE-ID \
  --questions /tmp/SPIKE-ID-interview-questions.json \
  --output /tmp/SPIKE-ID-interview-result.json \
  --timeout 600
```

The wrapper launches the direct-browser CLI, adds an external process watchdog to cover the
upstream no-browser-connect timeout limitation, preserves the returned JSON, writes local artifacts,
and posts the Linear audit comment. It exits successfully only after all decisions are answered and
the source-spike comment succeeds.

Local JSON and Markdown artifacts are mode `0600` under:

```text
${XDG_STATE_HOME:-$HOME/.local/state}/pi-fleet/spike-interviews/<SPIKE-ID>/
```

The upstream submitted-form snapshot is kept beneath the same run directory.

## Question contract

The fleet contract is `pi-fleet.spike-interview.v1`. Each interactive decision is a `single` or
`multi` question with:

| Field | Contract |
| --- | --- |
| `id` | Stable `<bucket>-NNN`, retained across retries, comments, and breakdowns |
| `bucket` | `architectural`, `technical`, `dependency`, or `product` |
| `question` | Exact decision prompt |
| `options` | At least two unique choices |
| `recommended` | One valid option for `single`; one or more for `multi` |
| `context` | Recommendation reasoning plus enough source context to decide quickly |
| `weight` | `critical` or `minor` |
| `conviction` | Optional `strong` or `slight` |

A completed upstream result missing any decision answer is downgraded to `partial` and cannot open
the decomposition gate.

## Linear audit comment

Before returning success, the wrapper posts this information to the source spike:

- schema version, source spike, interview ID, timestamps, status, channel, and pinned tool version;
- explicit `decompositionGate: OPEN` or `BLOCKED`;
- one section per stable ID containing bucket/weight, exact question, recommendation, conviction,
  reasoning/context, and exact answer;
- the complete machine-readable payload in a JSON block.

The primary channel is `agent-interview-cli/browser`. Asynchronously recorded answers use
`linear-comment/fallback`.

`OPEN` requires all of the following:

1. status is `completed`;
2. every decision has a non-empty response;
3. the local JSON/Markdown audit is persisted;
4. the structured Linear comment is posted successfully.

The spike seat must not draft a breakdown or create a project/issues before `OPEN`.

## Fail-loud fallback

Cancellation, partial submission, timeout, abort, malformed CLI output, and browser errors are
persisted and posted with a BLOCKED gate. Partial answers remain in the exact response array.

When `CI` is set, `PI_FLEET_INTERVIEW_NONINTERACTIVE=1`, or the pinned runtime is unavailable, the
wrapper does not pretend an interview occurred. It posts the entire unanswered question set with
`status=unavailable` and `channel=linear-comment/fallback`, exits non-zero, and requires the seat to
wait for explicit replies.

After replies arrive, transcribe them into the CLI response contract and post them through the same
gate:

```bash
pi-fleet-spike-interview record \
  --issue SPIKE-ID \
  --questions /tmp/SPIKE-ID-interview-questions.json \
  --result /tmp/SPIKE-ID-fallback-responses.json \
  --output /tmp/SPIKE-ID-interview-result.json
```

If the Linear write fails, the wrapper prints the retained local artifact path and exits `2`.
Decisions are not lost, but decomposition remains blocked until an audit comment succeeds.

## Spike surface audit

Audit performed 2026-07-14 with repository filename and content searches for `spike` and interview
mechanisms:

| Surface | Runs an interview? | Disposition |
| --- | --- | --- |
| `profiles/spike-breakdown/profile.yml` | Yes | Migrated to the direct-browser wrapper and hard audit gate |
| `skills/spike-breakdown/SKILL.md` | Yes | Migrated; defines question, fallback, audit, and decomposition contracts |
| `agents/spike-breakdown.md` | Yes, when cast as a subagent | Migrated to the same wrapper and gate |
| `bin/pi-spike-breakdown` | Launches the interview-running seat | Adds the clone-local fleet helper to `PATH`; retains its no-write/no-edit tool boundary |
| `bin/pi-fleet-spike-interview` | Integration wrapper | Owns pinned invocation, persistence, Linear audit, and fail-loud status |
| `skills/issue-breakdown/SKILL.md` | No | Downstream output-shaping skill; explicitly out of interview scope |
| Other profiles, skills, agents, and wrappers | No | No other spike agent or interview-running spike surface found |
| `bin/pi-fleet-smoke-spike-breakdown` and interview evals | No | Static and mocked runtime coverage only |

Thus `spike-breakdown` is the only interview-running spike agent, and both its profile and subagent
entry use the same CLI flow.

## Verification and live E2E

Deterministic checks do not open a browser or write to Linear:

```bash
node --test evals/spike-interview-contract.test.mjs
evals/pi-spike-interview-smoke-test.sh
bin/pi-fleet-smoke-spike-breakdown
evals/setup-sh-smoke-test.sh
```

The real acceptance run must use a lead-approved source spike that is not involved in another active
interview. Stage the seat through question generation and browser launch, then pause for the CEO to
answer the actual browser form. Evidence must include the returned audit JSON, the exact source-spike
comment, and a breakdown draft that cites and applies the stable decision IDs. Cancellation,
timeout, and non-interactive fallback can be demonstrated separately. Never manufacture a completed
browser response.

The browser UI is unmodified third-party UI, so project visual-QA does not apply. A genuine browser
completion remains mandatory because behavioral E2E—not visual styling—is the acceptance surface.
