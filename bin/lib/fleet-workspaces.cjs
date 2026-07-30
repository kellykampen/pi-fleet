/**
 * fleet-workspaces — persistent workspace registry under PI_FLEET_HOME (FLT-69).
 *
 * Path: $PI_FLEET_HOME/workspaces.json (default ~/.pi-fleet/workspaces.json)
 *
 * Resolution order (first hit wins):
 *   1. explicit slug / alias
 *   2. cmux title / name
 *   3. cwdMatchers, then repoMatchers
 *   4. basename of cwd (worktree-aware)
 *
 * Built-in defaults seed fantastic-dev (FTD / ftd-project-lead) and
 * pi-fleet (FLT / pi-fleet-project-lead) when the file is missing or incomplete.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const SCHEMA_VERSION = 1;
const FILE_NAME = "workspaces.json";

class FleetWorkspacesError extends Error {
  constructor(message, code = "fleet_workspaces_error") {
    super(message);
    this.name = "FleetWorkspacesError";
    this.code = code;
  }
}

const BUILTIN_DEFAULTS = Object.freeze({
  version: SCHEMA_VERSION,
  workspaces: Object.freeze({
    "fantastic-dev": Object.freeze({
      cmuxTitles: Object.freeze(["fantastic-dev", "Fantastic Dev", "ftd"]),
      aliases: Object.freeze(["ftd", "fantastic"]),
      cwdMatchers: Object.freeze(["fantastic-dev"]),
      repoMatchers: Object.freeze(["fantastic-dev", "github.com/*/fantastic-dev"]),
      linear: Object.freeze({ teamKey: "FTD" }),
      leadMailbox: "ftd-project-lead",
      allowedRepoRoots: Object.freeze([]),
      notes: "Default Fantastic Dev / FTD stream",
    }),
    "pi-fleet": Object.freeze({
      cmuxTitles: Object.freeze(["pi-fleet", "Pi Fleet", "flt"]),
      aliases: Object.freeze(["flt", "pi_fleet"]),
      cwdMatchers: Object.freeze(["pi-fleet"]),
      repoMatchers: Object.freeze(["pi-fleet", "github.com/*/pi-fleet"]),
      linear: Object.freeze({ teamKey: "FLT" }),
      leadMailbox: "pi-fleet-project-lead",
      allowedRepoRoots: Object.freeze([]),
      notes: "Default pi-fleet / FLT stream",
    }),
  }),
});

function resolveRuntimeRoot(env = process.env) {
  const raw = env.PI_FLEET_HOME || path.join(env.HOME || os.homedir(), ".pi-fleet");
  if (!path.isAbsolute(raw)) {
    throw new FleetWorkspacesError("PI_FLEET_HOME must be absolute", "bad_runtime_root");
  }
  const normalized = path.normalize(raw);
  if (
    normalized === path.sep ||
    normalized.includes(`${path.sep}..${path.sep}`) ||
    normalized.endsWith(`${path.sep}..`) ||
    normalized.includes(`${path.sep}.${path.sep}`) ||
    normalized.endsWith(`${path.sep}.`) ||
    normalized.includes("//")
  ) {
    throw new FleetWorkspacesError(
      "PI_FLEET_HOME must be a normalized, non-root path",
      "bad_runtime_root",
    );
  }
  try {
    return fs.realpathSync(normalized);
  } catch (error) {
    if (error && error.code === "ENOENT") return normalized;
    throw error;
  }
}

function workspacesPath(env = process.env) {
  return path.join(resolveRuntimeRoot(env), FILE_NAME);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "";
}

function asStringArray(value, field) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new FleetWorkspacesError(`${field} must be an array of strings`, "bad_schema");
  }
  return value.map((item, index) => {
    if (!isNonEmptyString(item)) {
      throw new FleetWorkspacesError(`${field}[${index}] must be a non-empty string`, "bad_schema");
    }
    return item.trim();
  });
}

function sanitizeSlug(raw) {
  if (!isNonEmptyString(raw)) return "";
  let value = raw.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-");
  value = value.replace(/^-+/, "").replace(/-+$/, "");
  if (value.endsWith("-project-lead")) value = value.slice(0, -"-project-lead".length);
  if (value === "" || value === "." || value === "..") return "";
  return value;
}

function defaultLeadMailbox(slug) {
  const key = sanitizeSlug(slug);
  if (!key) return "";
  // Align with <workspace>-project-lead (FLT-68 / FLT-69). Known short forms:
  if (key === "fantastic-dev" || key === "ftd") return "ftd-project-lead";
  return `${key}-project-lead`;
}

function normalizeWorkspaceEntry(slug, raw = {}) {
  if (!isNonEmptyString(slug)) {
    throw new FleetWorkspacesError("workspace slug is required", "bad_schema");
  }
  const key = sanitizeSlug(slug);
  if (!key) throw new FleetWorkspacesError(`invalid workspace slug: ${slug}`, "bad_schema");
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new FleetWorkspacesError(`workspace ${key} must be an object`, "bad_schema");
  }

  const linearRaw = raw.linear;
  let teamKey = "";
  if (linearRaw !== undefined && linearRaw !== null) {
    if (typeof linearRaw !== "object" || Array.isArray(linearRaw)) {
      throw new FleetWorkspacesError(`workspaces.${key}.linear must be an object`, "bad_schema");
    }
    if (linearRaw.teamKey !== undefined && linearRaw.teamKey !== null) {
      if (!isNonEmptyString(linearRaw.teamKey)) {
        throw new FleetWorkspacesError(
          `workspaces.${key}.linear.teamKey must be a non-empty string`,
          "bad_schema",
        );
      }
      teamKey = linearRaw.teamKey.trim().toUpperCase();
    }
  }

  let leadMailbox = isNonEmptyString(raw.leadMailbox)
    ? raw.leadMailbox.trim()
    : defaultLeadMailbox(key);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(leadMailbox)) {
    throw new FleetWorkspacesError(
      `workspaces.${key}.leadMailbox is invalid: ${leadMailbox}`,
      "bad_schema",
    );
  }
  // Prefer canonical *-project-lead form.
  if (leadMailbox === "project-lead") {
    leadMailbox = defaultLeadMailbox(key);
  }

  const allowedRepoRoots = asStringArray(raw.allowedRepoRoots, `workspaces.${key}.allowedRepoRoots`).map(
    (root) => {
      if (!path.isAbsolute(root)) {
        throw new FleetWorkspacesError(
          `workspaces.${key}.allowedRepoRoots entries must be absolute (got ${root})`,
          "bad_schema",
        );
      }
      return path.normalize(root);
    },
  );

  return {
    slug: key,
    cmuxTitles: asStringArray(raw.cmuxTitles, `workspaces.${key}.cmuxTitles`),
    aliases: asStringArray(raw.aliases, `workspaces.${key}.aliases`).map((a) =>
      sanitizeSlug(a),
    ).filter(Boolean),
    cwdMatchers: asStringArray(raw.cwdMatchers, `workspaces.${key}.cwdMatchers`),
    repoMatchers: asStringArray(raw.repoMatchers, `workspaces.${key}.repoMatchers`),
    linear: { teamKey },
    leadMailbox,
    allowedRepoRoots,
    notes: isNonEmptyString(raw.notes) ? raw.notes.trim() : "",
  };
}

function cloneDefaults() {
  const workspaces = {};
  for (const [slug, entry] of Object.entries(BUILTIN_DEFAULTS.workspaces)) {
    workspaces[slug] = normalizeWorkspaceEntry(slug, {
      cmuxTitles: [...entry.cmuxTitles],
      aliases: [...entry.aliases],
      cwdMatchers: [...entry.cwdMatchers],
      repoMatchers: [...entry.repoMatchers],
      linear: { ...entry.linear },
      leadMailbox: entry.leadMailbox,
      allowedRepoRoots: [...entry.allowedRepoRoots],
      notes: entry.notes,
    });
  }
  return { version: SCHEMA_VERSION, workspaces };
}

function normalizeDocument(raw) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new FleetWorkspacesError("workspaces.json root must be an object", "bad_schema");
  }
  const version = raw.version === undefined ? SCHEMA_VERSION : raw.version;
  if (version !== SCHEMA_VERSION) {
    throw new FleetWorkspacesError(
      `unsupported workspaces.json version: ${version} (expected ${SCHEMA_VERSION})`,
      "bad_schema",
    );
  }
  if (raw.workspaces === undefined || raw.workspaces === null) {
    throw new FleetWorkspacesError("workspaces.json requires a workspaces object", "bad_schema");
  }
  if (typeof raw.workspaces !== "object" || Array.isArray(raw.workspaces)) {
    throw new FleetWorkspacesError("workspaces must be an object keyed by slug", "bad_schema");
  }

  const workspaces = {};
  for (const [slug, entry] of Object.entries(raw.workspaces)) {
    const normalized = normalizeWorkspaceEntry(slug, entry);
    workspaces[normalized.slug] = normalized;
  }
  return { version: SCHEMA_VERSION, workspaces };
}

function mergeWithDefaults(doc) {
  const merged = cloneDefaults();
  for (const [slug, entry] of Object.entries(doc.workspaces)) {
    merged.workspaces[slug] = entry;
  }
  return merged;
}

function loadWorkspaces(options = {}) {
  const env = options.env || process.env;
  const filePath = options.path || workspacesPath(env);
  const mergeDefaults = options.mergeDefaults !== false;
  let doc;
  let source = "defaults";

  if (fs.existsSync(filePath)) {
    let rawText;
    try {
      rawText = fs.readFileSync(filePath, "utf8");
    } catch (error) {
      throw new FleetWorkspacesError(
        `failed to read ${filePath}: ${error.message}`,
        "io_error",
      );
    }
    let parsed;
    try {
      parsed = JSON.parse(rawText);
    } catch (error) {
      throw new FleetWorkspacesError(
        `invalid JSON in ${filePath}: ${error.message}`,
        "bad_json",
      );
    }
    doc = normalizeDocument(parsed);
    source = "file";
  } else {
    doc = cloneDefaults();
  }

  if (mergeDefaults && source === "file") {
    // File entries override defaults; missing default slugs remain available.
    doc = mergeWithDefaults(doc);
  } else if (mergeDefaults && source === "defaults") {
    // already defaults
  }

  return { path: filePath, source, document: doc };
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    // best-effort
  }
}

function writeWorkspaces(document, options = {}) {
  const env = options.env || process.env;
  const filePath = options.path || workspacesPath(env);
  const normalized = normalizeDocument(document);
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const payload = `${JSON.stringify(normalized, null, 2)}\n`;
  fs.writeFileSync(tmp, payload, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tmp, filePath);
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // best-effort
  }
  return { path: filePath, document: normalized };
}

function initWorkspaces(options = {}) {
  const env = options.env || process.env;
  const filePath = options.path || workspacesPath(env);
  const force = options.force === true;
  if (fs.existsSync(filePath) && !force) {
    const loaded = loadWorkspaces({ env, path: filePath, mergeDefaults: false });
    return { path: filePath, created: false, document: loaded.document };
  }
  const written = writeWorkspaces(cloneDefaults(), { env, path: filePath });
  return { path: written.path, created: true, document: written.document };
}

function sampleDocument() {
  return cloneDefaults();
}

function listWorkspaces(options = {}) {
  const loaded = loadWorkspaces(options);
  return {
    path: loaded.path,
    source: loaded.source,
    version: loaded.document.version,
    workspaces: Object.values(loaded.document.workspaces),
  };
}

function indexAliases(document) {
  const bySlug = new Map();
  const byAlias = new Map();
  const byTitle = new Map();
  for (const entry of Object.values(document.workspaces)) {
    bySlug.set(entry.slug, entry);
    for (const alias of entry.aliases) {
      byAlias.set(sanitizeSlug(alias), entry);
    }
    // slug itself is an implicit alias
    byAlias.set(entry.slug, entry);
    for (const title of entry.cmuxTitles) {
      byTitle.set(title.trim().toLowerCase(), entry);
    }
  }
  return { bySlug, byAlias, byTitle };
}

function matchPathMatcher(candidatePath, matcher) {
  if (!candidatePath || !matcher) return false;
  const normalizedPath = path.normalize(candidatePath);
  const lowerPath = normalizedPath.toLowerCase();
  let m = matcher.trim();
  if (!m) return false;

  // Absolute prefix match
  if (path.isAbsolute(m)) {
    const prefix = path.normalize(m).replace(/\/+$/, "");
    return (
      lowerPath === prefix.toLowerCase() ||
      lowerPath.startsWith(`${prefix.toLowerCase()}${path.sep}`)
    );
  }

  // Glob-ish: **/foo or foo/**
  m = m.replace(/\\/g, "/");
  const lowerMatcher = m.toLowerCase();
  if (lowerMatcher.startsWith("**/")) {
    const tail = lowerMatcher.slice(3).replace(/\/\*\*$/, "").replace(/\/+$/, "");
    if (!tail) return false;
    return (
      lowerPath.endsWith(`/${tail}`) ||
      lowerPath.includes(`/${tail}/`) ||
      lowerPath.endsWith(tail) ||
      path.basename(lowerPath) === tail
    );
  }
  if (lowerMatcher.endsWith("/**")) {
    const head = lowerMatcher.slice(0, -3);
    return lowerPath.includes(`/${head}/`) || lowerPath.endsWith(`/${head}`) || lowerPath.includes(head);
  }
  if (lowerMatcher.includes("*")) {
    // Limited: treat * as segment wildcard for repo URLs etc.
    const escaped = lowerMatcher
      .split("*")
      .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
      .join(".*");
    return new RegExp(escaped).test(lowerPath);
  }

  return (
    path.basename(lowerPath) === lowerMatcher ||
    lowerPath.endsWith(`/${lowerMatcher}`) ||
    lowerPath.includes(`/${lowerMatcher}/`) ||
    lowerPath.includes(lowerMatcher)
  );
}

function gitRemoteOrigin(cwd) {
  if (!cwd) return "";
  try {
    const result = spawnSync("git", ["-C", cwd, "remote", "get-url", "origin"], {
      encoding: "utf8",
      timeout: 2000,
    });
    if (result.status === 0 && result.stdout) return result.stdout.trim();
  } catch {
    // ignore
  }
  return "";
}

function gitTopLevel(cwd) {
  if (!cwd) return "";
  try {
    const result = spawnSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      timeout: 2000,
    });
    if (result.status === 0 && result.stdout) return result.stdout.trim();
  } catch {
    // ignore
  }
  return "";
}

function worktreeAwareBasename(cwd) {
  if (!cwd) return "";
  const normalized = path.normalize(cwd);
  const parts = normalized.split(path.sep);
  const wtIndex = parts.lastIndexOf(".worktrees");
  const wtIndex2 = parts.lastIndexOf("worktrees");
  const idx = Math.max(wtIndex, wtIndex2);
  if (idx > 0) {
    // .../<repo>/.worktrees/<leaf> → basename is repo
    return parts[idx - 1] || path.basename(normalized);
  }
  return path.basename(normalized);
}

/**
 * Resolve a workspace entry.
 *
 * @param {object} hints
 * @param {string} [hints.slug]
 * @param {string} [hints.alias]
 * @param {string} [hints.cmuxTitle]
 * @param {string} [hints.cwd]
 * @param {string} [hints.repo]
 * @param {object} [options]
 */
function resolveWorkspace(hints = {}, options = {}) {
  const loaded = loadWorkspaces(options);
  const { bySlug, byAlias, byTitle } = indexAliases(loaded.document);
  const tried = [];

  const hit = (method, entry) => ({
    path: loaded.path,
    source: loaded.source,
    method,
    workspace: entry,
  });

  // 1. slug / alias
  const explicit =
    sanitizeSlug(hints.slug || "") ||
    sanitizeSlug(hints.alias || "") ||
    sanitizeSlug(hints.projectKey || "");
  if (explicit) {
    tried.push(`slug/alias:${explicit}`);
    if (bySlug.has(explicit)) return hit("slug", bySlug.get(explicit));
    if (byAlias.has(explicit)) return hit("alias", byAlias.get(explicit));
  }

  // 2. cmux title
  const titleRaw = hints.cmuxTitle || hints.cmuxName || "";
  if (isNonEmptyString(titleRaw)) {
    const title = titleRaw.trim().toLowerCase();
    tried.push(`cmuxTitle:${title}`);
    if (byTitle.has(title)) return hit("cmuxTitle", byTitle.get(title));
    const titleSlug = sanitizeSlug(titleRaw);
    if (titleSlug && byAlias.has(titleSlug)) return hit("cmuxTitle-alias", byAlias.get(titleSlug));
  }

  // 3. cwd / repo matchers
  const cwd = hints.cwd ? path.normalize(hints.cwd) : "";
  const repo =
    hints.repo ||
    (cwd ? gitRemoteOrigin(cwd) : "") ||
    (cwd ? gitTopLevel(cwd) : "");

  if (cwd || repo) {
    for (const entry of Object.values(loaded.document.workspaces)) {
      for (const matcher of entry.cwdMatchers) {
        if (cwd && matchPathMatcher(cwd, matcher)) {
          tried.push(`cwdMatcher:${matcher}`);
          return hit("cwdMatcher", entry);
        }
      }
    }
    for (const entry of Object.values(loaded.document.workspaces)) {
      for (const matcher of entry.repoMatchers) {
        if (repo && matchPathMatcher(repo, matcher)) {
          tried.push(`repoMatcher:${matcher}`);
          return hit("repoMatcher", entry);
        }
      }
    }
  }

  // 4. basename
  if (cwd) {
    const base = sanitizeSlug(worktreeAwareBasename(cwd));
    tried.push(`basename:${base}`);
    if (base && bySlug.has(base)) return hit("basename", bySlug.get(base));
    if (base && byAlias.has(base)) return hit("basename-alias", byAlias.get(base));
  }

  return {
    path: loaded.path,
    source: loaded.source,
    method: null,
    workspace: null,
    tried,
  };
}

function pathContained(root, candidate) {
  const normalizedRoot = path.normalize(root);
  const normalizedCandidate = path.normalize(candidate);
  if (normalizedCandidate === normalizedRoot) return true;
  const rel = path.relative(normalizedRoot, normalizedCandidate);
  return rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

/**
 * Effective allowed repo roots for a resolved workspace + launch cwd.
 * Empty registry list → [git toplevel or launch cwd] so lead is always scoped.
 */
function effectiveAllowedRepoRoots(workspace, launchCwd) {
  const roots = [];
  if (workspace && Array.isArray(workspace.allowedRepoRoots)) {
    for (const root of workspace.allowedRepoRoots) {
      if (isNonEmptyString(root)) roots.push(path.normalize(root));
    }
  }
  if (roots.length === 0 && launchCwd) {
    const top = gitTopLevel(launchCwd);
    roots.push(path.normalize(top || launchCwd));
  }
  // unique
  return [...new Set(roots)];
}

function assertPathAllowed(candidate, allowedRoots) {
  if (!allowedRoots || allowedRoots.length === 0) return { allowed: true };
  if (!candidate) return { allowed: false, reason: "path is required under allowedRepoRoots" };
  const normalized = path.normalize(candidate);
  for (const root of allowedRoots) {
    if (pathContained(root, normalized)) return { allowed: true, root };
  }
  return {
    allowed: false,
    reason: `path ${normalized} is outside allowedRepoRoots (${allowedRoots.join(", ")})`,
  };
}

/**
 * Build env exports for project-lead / worker inheritance.
 */
function envForWorkspace(workspace, launchCwd, options = {}) {
  if (!workspace) return {};
  const roots = effectiveAllowedRepoRoots(workspace, launchCwd);
  const env = {
    FLEET_WORKSPACE_SLUG: workspace.slug,
    FLEET_PROJECT_KEY: workspace.slug,
    FLEET_LEAD_MAILBOX: workspace.leadMailbox,
    FLEET_SEAT_NAME: workspace.leadMailbox,
    FLEET_LINEAR_TEAM_KEY: workspace.linear.teamKey || "",
    FLEET_ALLOWED_REPO_ROOTS: roots.join(path.delimiter),
    FLEET_WORKSPACES_PATH: options.workspacesPath || "",
  };
  if (!options.preserveMailFrom) {
    env.FLEET_MAIL_FROM = workspace.leadMailbox;
  }
  if (!options.preserveMailTo) {
    // Workers cast from this lead should default --to to the lead mailbox.
    env.FLEET_MAIL_TO = workspace.leadMailbox;
  }
  return env;
}

module.exports = {
  SCHEMA_VERSION,
  FILE_NAME,
  BUILTIN_DEFAULTS,
  FleetWorkspacesError,
  resolveRuntimeRoot,
  workspacesPath,
  sanitizeSlug,
  defaultLeadMailbox,
  normalizeWorkspaceEntry,
  normalizeDocument,
  loadWorkspaces,
  writeWorkspaces,
  initWorkspaces,
  sampleDocument,
  listWorkspaces,
  resolveWorkspace,
  matchPathMatcher,
  worktreeAwareBasename,
  effectiveAllowedRepoRoots,
  assertPathAllowed,
  envForWorkspace,
  gitTopLevel,
  gitRemoteOrigin,
};
