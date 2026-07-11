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

## Verification

Run:

```bash
bin/pi-fleet-eval-model-overrides
```

The script mocks `outfitter` and asserts the final wrapper launch args for role env, generic env, role alias, and explicit CLI precedence.
