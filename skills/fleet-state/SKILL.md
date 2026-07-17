---
name: fleet-state
description: Secure pi-fleet runtime state, handoff, migration, and retention rules
---

# Fleet state

Follow [`docs/runtime-state.md`](../../docs/runtime-state.md); do not copy durable policy into a
handoff or personal note. `~/.pi-fleet` (or an absolute, normalized `PI_FLEET_HOME`) is the sole
pi-fleet runtime root.

- Never create ad-hoc top-level files. Use a schema-defined namespace and its owning writer.
- Never read aloud, log, include in prompts, or otherwise disclose secret contents. Refer to secret
  files by purpose/path only and sanitize diagnostics.
- Never treat copied durable policy as authoritative. Repository skills and docs are authoritative.
- Never keep multiple current handoffs for an owner. The conductor uses
  `<root>/handoffs/conductor/current.md`; each project uses
  `<root>/handoffs/projects/<stable-id>/current.md`, where the stable ID is not a display name.
- Move superseded handoffs explicitly to that owner's `archive/` directory; exactly one
  `current.md` may remain.
- Migration and retention are report-only by default. Require an explicit apply action, never
  overwrite a conflict or delete a migration source, and roll back only unchanged created files.
- Use private modes, bounded locks, atomic writes, and the owning helper rather than direct writers.
- Pi-owned `~/.pi/agent` and OS-owned LaunchAgents are external, not alternate fleet roots.
