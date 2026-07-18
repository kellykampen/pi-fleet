# Plan 001: Make `~/.pi-fleet` the sole secure pi-fleet runtime root

> Executor: implement this plan test-first. Work only in this isolated worktree. Do not touch the main checkout. Never print or copy secret values. Migration must be report-only by default and non-destructive when applied.

## Status

- Priority: P1
- Effort: L
- Risk: MED
- Depends on: none
- Category: security, migration, architecture, docs
- Planned at: commit `6e0051b`, 2026-07-17

## Why

Pi-fleet currently persists data across `~/.pi/fleet`, `~/.pi-fleet`, `~/.pi/agent`, and `~/Library/Logs/pi-fleet` without a complete ownership, permissions, locking, or retention contract. E2B job lookup also accepts path traversal. The approved invariant is that `~/.pi-fleet` is the sole pi-fleet-owned runtime root, overrideable only by an absolute `PI_FLEET_HOME`.

## Required outcome

1. Add canonical `docs/runtime-state.md` and a versioned machine-readable schema covering ownership, authority, namespace, sensitivity, modes, locking, atomicity, retention, cleanup, migration, rollback, and external Pi/OS-owned paths.
2. Add shared shell and TypeScript runtime-path helpers. Default root is `~/.pi-fleet`; an absolute `PI_FLEET_HOME` overrides it. Reject relative/unsafe roots. Rename the existing checkout-location use of `PI_FLEET_HOME` to an unambiguous repo-root variable.
3. Secure the E2B local job store beneath `<root>/state/e2b/jobs`: strict job-ID validation/containment, no symlinks, `0700` directories, `0600` files, atomic temp+fsync+rename, bounded cross-process locking, explicit corrupt-record errors/quarantine, and concurrency-safe updates.
4. Add dry-run-by-default job retention: keep active jobs; archive old terminal jobs; explicitly apply deletion only to sufficiently old archived records.
5. Add `bin/pi-fleet-state-migrate`: inventory legacy `~/.pi/fleet/jobs`, `~/.pi/fleet/secrets.env`, and recognized loose `~/.pi-fleet` content. Default is report-only. `--apply` copies without overwriting or deleting sources, enforces private modes, and writes a private hash manifest. Rollback removes only unchanged migration-created destinations. Never reveal secrets.
6. Move personal logs under `<root>/logs/personal`; make them private and bounded/rotated. Generated LaunchAgents must not direct pi-fleet logs to `~/Library/Logs/pi-fleet`.
7. Harden scheduler cleanup with private bounded backups under `<root>/state/scheduler/backups`, locking, atomic writes, and quarantine/preservation of corrupt input.
8. Add `skills/fleet-state/SKILL.md`. Wire it into stateful top-level profiles and relevant spawnable agents. It must prohibit ad-hoc top-level files, secret disclosure, copied durable policy, multiple current handoffs per owner, and destructive-default migration. Define canonical handoff locations under `<root>/handoffs/{conductor,projects/<stable-id>}` with exactly one `current.md` and explicit archives.
9. Add structural evals that reject deprecated pi-fleet roots, direct unsafe writers, missing fleet-state wiring, and stale scheduler/storage guidance.
10. Consolidate README and specialized docs around the canonical runtime-state document. Bootstrap/setup must create/repair the root privately and offer the non-destructive migration, without silently applying it.

## TDD and verification

Write tests/evals first and observe expected failures before production changes. Cover traversal and separators, absolute IDs, valid legacy IDs, permissions, atomic writes, concurrent non-conflicting updates, corruption, retention boundaries, migration dry-run/apply/conflict/rollback, log rotation, scheduler concurrency/corruption, root overrides, and structural skill/path rules.

Run:

```bash
(cd extensions/e2b && npm test)
bash evals/pi-scheduler-isolation-smoke-test.sh
bash evals/pi-personal-schedule-sync-smoke-test.sh
bash evals/pi-runtime-state-smoke-test.sh
bash evals/pi-runtime-state-structural-test.sh
bash evals/pi-project-lead-extension-path-smoke-test.sh
git diff --check
```

All must exit 0 without real credentials, E2B access, or writes to the operator's actual home.

## Boundaries

- Do not delete or mutate the operator's existing legacy files.
- Do not embed machine-specific `/Users/...` paths.
- Do not move Pi-owned state out of `~/.pi/agent`; document it as external.
- Do not modify model-roster or QC policy unrelated to runtime state.
- Do not weaken tool or bash permissions.

## STOP conditions

Stop and report if a safe implementation requires destructive migration by default, real secrets, changes to the main checkout, or an unapproved new persistence backend. Otherwise make conservative decisions and document constants such as retention limits.

## Done criteria

- All ten required outcomes are implemented and documented.
- New tests were observed failing before implementation and now pass.
- Existing relevant tests/evals pass.
- No production reference treats `~/.pi/fleet` or `~/Library/Logs/pi-fleet` as a current pi-fleet-owned runtime location, except migration/history documentation and tests.
- `git diff --check` passes and changed files stay within this plan's scope.
