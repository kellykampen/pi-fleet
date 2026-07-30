# Pi model/provider overrides

Pi profile `provider` and `model` values are documented defaults, not locks. The `bin/pi-*` wrappers merge launch-time overrides before invoking `outfitter run`.

## Precedence

Highest precedence first:

1. Explicit CLI flags passed to the wrapper: `--provider ...` / `--model ...` (also supports `--provider=...` / `--model=...`).
2. Role-specific environment variables: `PI_<ROLE>_PROVIDER` and `PI_<ROLE>_MODEL`, with the role uppercased and hyphens converted to underscores, e.g. `PI_AC_VERIFIER_MODEL`.
3. Role aliases where defined: `pi-project-lead` also accepts `PI_LEAD_PROVIDER` / `PI_LEAD_MODEL`; `pi-personal-assistant` also accepts `PI_ASSISTANT_*` and `PI_PERSONAL_*`; `pi-spike-breakdown` also accepts `PI_SPIKE_*`.
4. Generic environment variables: `PI_PROVIDER` / `PI_MODEL`.
5. The profile default in `profiles/<role>/profile.yml`.

Explicit CLI flags always win over env defaults.

## GPT usage guard — active model-routing override (FLT-55)

> **Effective immediately, new GPT/OpenAI worker casts are blocked unless explicitly CEO/conductor-approved while this guard is active.** Weekly GPT/OpenAI quota is nearly exhausted, so project leads must not route new implementer/reviewer/AC-verifier/QA seats to `openai-codex` or any GPT model without a clear approval from the CEO or conductor.
>
> This override is temporary. It does not change the profile defaults below; it governs **new casts** until the guard is lifted.

### Preferred non-GPT pi workers

When the task allows, cast non-GPT pi workers using these exact provider/model pairs:

| Preferred model | Pi flags | Typical seat |
| --- | --- | --- |
| Grok 4.5 | `--provider xai-auth --model grok-4.5-latest` | `pi-implementer`, `pi-reviewer`, `pi-ac-verifier`, `pi-visual-qa` |
| Kimi K3 | `--provider kimi-coding --model k/3` | `pi-implementer`, `pi-reviewer`, `pi-ac-verifier`, `pi-visual-qa` |

### Grok / `xai-auth` requirements

- Provider id is **`xai-auth`**, registered by the installed package **`npm:pi-xai-oauth`**. It is not the built-in API-key provider id `xai`.
- Interactive `pi` loads packages from `~/.pi/agent/settings.json`, so `/login xai-auth` and model pickers work there.
- Worker wrappers (`pi-implementer`, …) do **not** pass `--no-extensions`, so package auto-discovery still loads `pi-xai-oauth` and Grok casts work:
  ```bash
  # Direct (packages on; do not add --no-extensions here):
  pi --provider xai-auth --model grok-4.5-latest -p "Reply OK" --no-session --no-tools
  # or fleet worker:
  pi-implementer --provider xai-auth --model grok-4.5-latest -p "Reply OK"
  ```
- `pi-project-lead` / `pi-conductor` pass `--no-extensions` (FLT-35). They re-include `pi-xai-oauth` via an explicit `--extension` when installed (`bin/lib/pi-xai-oauth-ext.sh`) so lead/conductor seats can also use `xai-auth`. Without that package installed, those seats fail with `Unknown provider "xai-auth"`.
- Do **not** cast `pi --provider xai-auth` under a bare `--no-extensions` invocation without also passing the oauth extension path.

Exact cross-model workflows:

```bash
# Workflow A: Grok implementation, Kimi review/verification
cd <worktree> && pi-implementer --provider xai-auth --model grok-4.5-latest
cd <worktree> && pi-reviewer --provider kimi-coding --model k/3
cd <worktree> && pi-ac-verifier --provider kimi-coding --model k/3

# Workflow B: Kimi implementation, Grok review/verification
cd <worktree> && pi-implementer --provider kimi-coding --model k/3
cd <worktree> && pi-reviewer --provider xai-auth --model grok-4.5-latest
cd <worktree> && pi-ac-verifier --provider xai-auth --model grok-4.5-latest
```

### Verification quality and model diversity

The guard does **not** relax verification quality:

- Independent review must still be **posted on the PR** and run on a **different model** than the implementer.
- The AC verifier must still collect both Linear-ticket and PR-body acceptance criteria, verify every item against the PR's **actual head commit**, record the verified SHA, run constrained validation commands, fail if validation dirties the worktree, and post evidence to the PR and Linear.
- Preserve model independence across the chain: if the implementer ran on Grok, prefer Kimi for the reviewer and AC verifier (and vice versa). If a non-preferred model was explicitly approved, still keep reviewer/verifier different from implementer unless the override explicitly says otherwise.

## Current pi role defaults

| Wrapper | Default provider | Default model | Reason |
| --- | --- | --- | --- |
| `pi-implementer` | `openai-codex` | `gpt-5.6-sol` | Hard implementation/coding fallback. |
| `pi-reviewer` | `openai-codex` | `gpt-5.5` | Cost-effective independent read-only review fallback. |
| `pi-ac-verifier` | `openai-codex` | `gpt-5.5` | Deterministic verification fallback; project lead may override for model diversity. |
| `pi-researcher` | `openai-codex` | `gpt-5.5` | Lightweight read-only scouting. |
| `pi-linear` | `openai-codex` | `gpt-5.5` | Lightweight Linear management. |
| `pi-docs` | `openai-codex` | `gpt-5.5` | Documentation gate. |
| `pi-conductor` | `openai-codex` | `gpt-5.5` | Portfolio routing and coordination. |
| `pi-project-lead` | `openai-codex` | `gpt-5.5` | Project routing and worker casting. |
| `pi-designer` | `openai-codex` | `gpt-5.6-terra` | Taste/design-heavy work. |
| `pi-planner` | `openai-codex` | `gpt-5.6-terra` | Product/architecture planning. |
| `pi-spike-breakdown` | `openai-codex` | `gpt-5.5` | Safe fallback; profile prompt recommends overriding to a taste model when needed. |
| `pi-security-reviewer` | `openai-codex` | `gpt-5.6-sol` | Security reasoning. |
| `pi-visual-qa` | `openai-codex` | `gpt-5.6-terra` | Visual/taste QA. |
| `pi-remotion` | `openai-codex` | `gpt-5.6-terra` | Taste/video generation. |
| `pi-personal-assistant` | `openai-codex` | `gpt-5.6-terra` | Personal voice/taste work. |

Roster-banned model families are not defaults: Gemini/agy, Grok/xAI, Kimi, and GLM.

> **During the active GPT usage guard (see [GPT usage guard](#gpt-usage-guard--active-model-routing-override-flt-55) above), do not use these OpenAI defaults for new worker casts without explicit CEO/conductor approval.** Prefer `xai-auth/grok-4.5-latest` or `kimi-coding/k/3` instead.

## Verification

Run:

```bash
bin/pi-fleet-eval-model-overrides
```

The script mocks `outfitter` and asserts the final wrapper launch args for role env, generic env, role alias, and explicit CLI precedence.
