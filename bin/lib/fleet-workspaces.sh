#!/usr/bin/env bash
# FLT-69: load PI_FLEET_HOME/workspaces.json and resolve the active workspace.
#
# Sourced by pi-conductor (after optional cmux discovery helpers) and by
# pi-project-lead launch so FLEET_WORKSPACE_SLUG / FLEET_LEAD_MAILBOX /
# FLEET_ALLOWED_REPO_ROOTS are hard-exported for the seat + cast workers.
#
# Requires: node, bin/lib/fleet-workspaces.cjs (same tree as this file).

fleet_workspaces_lib_path() {
  local here
  here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  printf '%s\n' "$here/fleet-workspaces.cjs"
}

fleet_workspaces_cli() {
  local here root
  here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  root="$(cd "$here/../.." && pwd)"
  if [[ -x "$root/bin/fleet-workspaces" ]]; then
    "$root/bin/fleet-workspaces" "$@"
  else
    node "$(fleet_workspaces_lib_path)" "$@"
  fi
}

# Resolve registry path (prints one line).
fleet_workspaces_path() {
  node -e 'const m=require(process.argv[1]); process.stdout.write(m.workspacesPath()+"\n")' \
    "$(fleet_workspaces_lib_path)"
}

# Ensure defaults exist on disk (non-destructive).
fleet_workspaces_ensure_file() {
  node -e '
const m = require(process.argv[1]);
const r = m.initWorkspaces({ force: false });
process.stdout.write(r.path + "\n");
' "$(fleet_workspaces_lib_path)"
}

# Resolve workspace from env/cwd and export seat env vars.
#
# Inputs (optional):
#   FLEET_WORKSPACE_SLUG / FLEET_PROJECT_KEY / CMUX_WORKSPACE_NAME
#   CMUX_WORKSPACE_TITLE / CMUX_WORKSPACE_ID (title preferred for match)
#   FLEET_COORDINATION_ROOT / cwd
#   FLEET_WORKSPACES_STRICT=1 → fail if unresolved when a hint was present
#
# Exports when resolved:
#   FLEET_WORKSPACE_SLUG, FLEET_PROJECT_KEY, FLEET_LEAD_MAILBOX, FLEET_SEAT_NAME,
#   FLEET_LINEAR_TEAM_KEY, FLEET_ALLOWED_REPO_ROOTS, FLEET_WORKSPACES_PATH,
#   FLEET_MAIL_FROM (if unset), FLEET_MAIL_TO (if unset, for worker inheritance)
fleet_workspaces_resolve_and_export() {
  local launch_cwd export_lines lib
  launch_cwd="${FLEET_COORDINATION_ROOT:-$(pwd -P 2>/dev/null || pwd)}"
  lib="$(fleet_workspaces_lib_path)"

  export_lines="$(
    PI_FLEET_HOME="${PI_FLEET_HOME-}" \
    FLEET_WORKSPACE_SLUG="${FLEET_WORKSPACE_SLUG-}" \
    FLEET_PROJECT_KEY="${FLEET_PROJECT_KEY-}" \
    CMUX_WORKSPACE_NAME="${CMUX_WORKSPACE_NAME-}" \
    CMUX_WORKSPACE_TITLE="${CMUX_WORKSPACE_TITLE-}" \
    FLEET_COORDINATION_ROOT="$launch_cwd" \
    FLEET_MAIL_FROM="${FLEET_MAIL_FROM-}" \
    FLEET_MAIL_TO="${FLEET_MAIL_TO-}" \
    FLEET_WORKSPACES_STRICT="${FLEET_WORKSPACES_STRICT-}" \
    node -e '
const m = require(process.argv[1]);
const launchCwd = process.argv[2];
const env = process.env;
const hints = {
  slug: env.FLEET_WORKSPACE_SLUG || env.FLEET_PROJECT_KEY || env.CMUX_WORKSPACE_NAME || "",
  cmuxTitle: env.CMUX_WORKSPACE_TITLE || env.CMUX_WORKSPACE_NAME || "",
  cwd: launchCwd,
};
const resolved = m.resolveWorkspace(hints, { env });
if (!resolved.workspace) {
  const tried = JSON.stringify(resolved.tried || []);
  if (env.FLEET_WORKSPACES_STRICT === "1" && (hints.slug || hints.cmuxTitle)) {
    process.stderr.write("fleet-workspaces: could not resolve workspace (tried " + tried + ")\n");
    process.exit(2);
  }
  process.stdout.write("export FLEET_WORKSPACES_PATH=" + JSON.stringify(resolved.path) + "\n");
  process.exit(0);
}
const exportsMap = m.envForWorkspace(resolved.workspace, launchCwd, {
  workspacesPath: resolved.path,
  preserveMailFrom: Boolean(env.FLEET_MAIL_FROM),
  preserveMailTo: Boolean(env.FLEET_MAIL_TO),
});
for (const [key, value] of Object.entries(exportsMap)) {
  if (value === "" || value === undefined) continue;
  if (key === "FLEET_MAIL_FROM" && env.FLEET_MAIL_FROM) continue;
  if (key === "FLEET_MAIL_TO" && env.FLEET_MAIL_TO) continue;
  process.stdout.write("export " + key + "=" + JSON.stringify(String(value)) + "\n");
}
process.stdout.write(
  "export FLEET_WORKSPACE_RESOLVE_METHOD=" + JSON.stringify(resolved.method || "") + "\n",
);
' "$lib" "$launch_cwd"
  )" || return $?

  # Apply exports in the caller's shell.
  eval "$export_lines"
  return 0
}

# Conductor helper: after `cmux workspace list --json`, map each entry to a registry row.
# Reads JSON from stdin (array or {workspaces:[]}); prints TSV:
# slug\tleadMailbox\tteamKey\tcmuxTitle\tid\tmethod
fleet_workspaces_map_cmux_list() {
  local lib
  lib="$(fleet_workspaces_lib_path)"
  node -e '
const fs = require("node:fs");
const m = require(process.argv[1]);
const text = fs.readFileSync(0, "utf8").trim();
if (!text) process.exit(0);
let data;
try { data = JSON.parse(text); } catch (e) {
  process.stderr.write("fleet-workspaces: invalid cmux JSON: " + e.message + "\n");
  process.exit(2);
}
const items = Array.isArray(data)
  ? data
  : (data.workspaces || data.items || data.data || []);
for (const item of items) {
  if (!item || typeof item !== "object") continue;
  const title = item.title || item.name || item.label || "";
  const id = item.id || item.workspaceId || item.workspace_id || "";
  const cwd = item.cwd || item.path || item.root || "";
  const resolved = m.resolveWorkspace({
    cmuxTitle: title,
    slug: item.slug || item.key || "",
    cwd,
  }, { env: process.env });
  const ws = resolved.workspace;
  const slug = ws ? ws.slug : (m.sanitizeSlug(title) || id || "?");
  const lead = ws ? ws.leadMailbox : (slug && slug !== "?" ? slug + "-project-lead" : "");
  const team = ws ? (ws.linear.teamKey || "") : "";
  process.stdout.write([slug, lead, team, title, id, resolved.method || "unmapped"].join("\t") + "\n");
}
' "$lib"
}
