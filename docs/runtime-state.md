# Runtime state contract

This is the canonical storage policy for pi-fleet. The versioned machine-readable companion is
[`runtime-state.schema.v1.json`](runtime-state.schema.v1.json).

## Root, ownership, and authority

Pi-fleet owns exactly one runtime root: `~/.pi-fleet`. `PI_FLEET_HOME` may override it only with a
normalized absolute path that is not `/`; unsafe and relative values fail closed. Symlinks in the
configured root's ancestry are resolved once to a canonical physical root, and symlinked namespace
components are rejected. The checkout is not runtime state and is selected separately with
`PI_FLEET_REPO_ROOT` where needed.

Every directory is mode `0700`; every state, log, manifest, backup, and secret file is `0600`.
Callers repair modes when opening an existing namespace. State is namespaced by authority:

| Namespace | Owner / authority | Sensitivity | Retention and cleanup |
| --- | --- | --- | --- |
| `state/e2b/jobs` | E2B job lifecycle | private; sanitized | active retained; terminal jobs are archive-eligible after 30 days; archived records are deletion-eligible after 180 days |
| `state/scheduler/{backups,quarantine}` | global-scheduler cleanup evidence | private | after a validated fleet-owned cleanup, prune backups and quarantines to the newest 20; otherwise preserve quarantines for operator review |
| `state/migrations` | migration manifests | private | retain through rollback window |
| `archive/legacy-root` | non-authoritative copies of recognized loose legacy root content | private | operator-managed migration history; never treated as current state |
| `secrets` | fleet-only credentials | secret | operator-managed; never print values |
| `logs/personal` | personal LaunchAgent output | private | rotate above 5 MiB; keep three generations |
| `handoffs/conductor` | conductor coordination | private | exactly one `current.md`; older handoffs in `archive/` |
| `handoffs/projects/<stable-id>` | one stable project owner | private | exactly one `current.md`; older handoffs in `archive/` |
| `mail/<mailbox>` | fleet-mail (async seat inbox) | private | unacked retained; acked pruned when inbox exceeds bound; rate files under `mail/rate/` |
| `workspaces.json` | fleet-workspaces registry (FLT-69) | private | operator-managed; mode 0600; schema v1 |

No ad-hoc top-level files are allowed. Add a named namespace and update the schema before adding a
writer. Durable policy belongs in repository docs/skills, not copied into handoffs. Workspace
registry details: [`workspaces.md`](./workspaces.md).

## Writes, locking, corruption, and cleanup

Mutable shared stores use a bounded five-second cross-process lock. Writers create a private temp
file in the destination directory, flush it, `fsync`, rename atomically, then clean the temp.
E2B job IDs accept only 1–128 ASCII letters, digits, dot, underscore, and hyphen; separators,
absolute paths, traversal, non-regular files, and symlinks are rejected. Corrupt records produce an
explicit error and move to private quarantine rather than disappearing from listings.

Retention is dry-run/report-only by default (`npm run jobs:retain` in `extensions/e2b`). Active
jobs are never archived. Archiving requires `--apply`; deletion additionally requires
`--delete-archived` and the age boundary. Scheduler cleanup serializes concurrent callers,
atomically removes only validated pi-fleet-owned leaked tasks, keeps bounded private evidence, and
preserves unrelated or corrupt external input while copying corrupt input to quarantine.

## Migration and rollback

Run `bin/pi-fleet-state-migrate` to inventory recognized legacy job and secret locations plus
regular loose top-level files/directories. Canonical namespaces are excluded; loose content is
copied only beneath the explicitly non-authoritative `archive/legacy-root` namespace. Its default
is **report-only** and it never displays file contents. `--apply` copies without overwriting or
deleting sources, enforces private modes, and atomically writes a private SHA-256 manifest under a
bounded migration lock. Conflicts are reported and preserved. `--rollback` removes only migration-created destinations
whose hash is unchanged; modified destinations and every source remain untouched. There is no
implicit or destructive migration.

## External Pi and OS state

`~/.pi/agent` is owned by Pi and stays external. Pi-fleet links configuration there and may empty
validated pi-fleet-owned entries from Pi's machine-global scheduler task file while preserving
unrelated, external, and corrupt content; it never empties or truncates the entire file. Pi-fleet
does not move or claim Pi's auth/session state.
`~/Library/LaunchAgents` is owned by macOS launchd; pi-fleet manages only its
`dev.pi-fleet.personal.*` plist files. Personal logs remain in the runtime root, never an OS log
namespace.
