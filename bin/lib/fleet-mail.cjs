/**
 * fleet-mail core: durable file-backed async inbox between fleet seats.
 *
 * Topology (enforced):
 *   worker | reviewer | ac-verifier  →  project-lead only
 *   project-lead                     →  conductor (compact rollup)
 *   conductor                        →  project-lead
 *   conductor never accepts worker/reviewer/ac-verifier mail
 *
 * Anti-spam:
 *   - rate limit per from→to (non-status)
 *   - type=status with ticket replaces prior unacked status for same slot
 */

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const MESSAGE_TYPES = Object.freeze([
  "status",
  "blocker",
  "done",
  "ask",
  "review",
  "ac",
]);

const BASE_ROLES = Object.freeze([
  "worker",
  "reviewer",
  "ac-verifier",
  "project-lead",
  "conductor",
  "coordinator",
]);

const WORKER_FAMILY = new Set(["worker", "reviewer", "ac-verifier"]);
const LEAD_FAMILY = new Set(["project-lead"]);
const CONDUCTOR_FAMILY = new Set(["conductor", "coordinator"]);

const DEFAULT_RATE_LIMIT = 30;
const DEFAULT_RATE_WINDOW_MS = 60_000;
const LOCK_TIMEOUT_MS = 5_000;
const LOCK_POLL_MS = 25;
const MAX_BODY = 4_000;
const MAILBOX_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

class FleetMailError extends Error {
  constructor(message, code = "fleet_mail_error") {
    super(message);
    this.name = "FleetMailError";
    this.code = code;
  }
}

function resolveRuntimeRoot(env = process.env) {
  const raw = env.PI_FLEET_HOME || path.join(env.HOME || os.homedir(), ".pi-fleet");
  if (!path.isAbsolute(raw)) {
    throw new FleetMailError("PI_FLEET_HOME must be absolute", "bad_runtime_root");
  }
  const normalized = path.normalize(raw);
  if (normalized === path.sep || normalized.includes(`${path.sep}..${path.sep}`) || normalized.endsWith(`${path.sep}..`)) {
    throw new FleetMailError("PI_FLEET_HOME must be a normalized, non-root path", "bad_runtime_root");
  }
  return fs.realpathSync.native ? safeRealpath(normalized) : safeRealpath(normalized);
}

function safeRealpath(candidate) {
  try {
    return fs.realpathSync(candidate);
  } catch (error) {
    if (error && error.code === "ENOENT") return candidate;
    throw error;
  }
}

function normalizeMailbox(name) {
  if (typeof name !== "string" || name.trim() === "") {
    throw new FleetMailError("mailbox is required", "bad_mailbox");
  }
  const trimmed = name.trim();
  if (trimmed.includes("\\") || trimmed.includes("/") || trimmed.includes("..")) {
    throw new FleetMailError(`invalid mailbox: ${name}`, "bad_mailbox");
  }
  if (!MAILBOX_RE.test(trimmed)) {
    throw new FleetMailError(`invalid mailbox: ${name}`, "bad_mailbox");
  }
  if (trimmed === "coordinator") return "conductor";
  return trimmed;
}

function baseRole(mailbox) {
  const id = normalizeMailbox(mailbox);
  const head = id.split(":")[0];
  if (!BASE_ROLES.includes(head) && head !== "conductor") {
    // Allow project-scoped ids that still start with a known role.
    throw new FleetMailError(`unknown mailbox role: ${id}`, "bad_mailbox");
  }
  return head === "coordinator" ? "conductor" : head;
}

function assertTopology(from, to) {
  const fromRole = baseRole(from);
  const toRole = baseRole(to);

  if (fromRole === toRole && normalizeMailbox(from) === normalizeMailbox(to)) {
    throw new FleetMailError("cannot mail yourself", "topology");
  }

  if (WORKER_FAMILY.has(fromRole)) {
    if (!LEAD_FAMILY.has(toRole)) {
      throw new FleetMailError(
        `topology: ${fromRole} may only mail project-lead (not ${toRole})`,
        "topology",
      );
    }
    return;
  }

  if (LEAD_FAMILY.has(fromRole)) {
    if (!CONDUCTOR_FAMILY.has(toRole) && !WORKER_FAMILY.has(toRole) && !LEAD_FAMILY.has(toRole)) {
      throw new FleetMailError(
        `topology: project-lead may mail conductor or workers, not ${toRole}`,
        "topology",
      );
    }
    return;
  }

  if (CONDUCTOR_FAMILY.has(fromRole)) {
    if (!LEAD_FAMILY.has(toRole)) {
      throw new FleetMailError(
        `topology: conductor may only mail project-lead (not ${toRole}); worker mail is rejected`,
        "topology",
      );
    }
    return;
  }

  throw new FleetMailError(`topology: unknown sender role ${fromRole}`, "topology");
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    // best-effort on platforms that ignore mode
  }
}

function mailRoot(runtimeRoot) {
  return path.join(runtimeRoot, "mail");
}

function mailboxDir(runtimeRoot, mailbox) {
  return path.join(mailRoot(runtimeRoot), normalizeMailbox(mailbox));
}

function inboxPath(runtimeRoot, mailbox) {
  return path.join(mailboxDir(runtimeRoot, mailbox), "inbox.json");
}

function ratePath(runtimeRoot, from, to) {
  const key = `${normalizeMailbox(from)}__${normalizeMailbox(to)}`.replace(/[/\\:]/g, "_");
  return path.join(mailRoot(runtimeRoot), "rate", `${key}.json`);
}

function sleep(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    // portable busy-wait; lock hold times are short
  }
}

function withLock(lockDir, fn) {
  ensureDir(path.dirname(lockDir));
  const started = Date.now();
  while (true) {
    try {
      fs.mkdirSync(lockDir);
      break;
    } catch (error) {
      if (!error || error.code !== "EEXIST") throw error;
      if (Date.now() - started > LOCK_TIMEOUT_MS) {
        throw new FleetMailError("mail lock timeout", "lock_timeout");
      }
      sleep(LOCK_POLL_MS);
    }
  }
  try {
    return fn();
  } finally {
    try {
      fs.rmdirSync(lockDir);
    } catch {
      // ignore
    }
  }
}

function atomicWriteJson(target, value) {
  ensureDir(path.dirname(target));
  const tmp = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`,
  );
  const payload = `${JSON.stringify(value, null, 2)}\n`;
  const fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
  try {
    fs.writeFileSync(fd, payload, { encoding: "utf8" });
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, target);
  try {
    fs.chmodSync(target, 0o600);
  } catch {
    // best-effort
  }
}

function readJson(target, fallback) {
  try {
    const raw = fs.readFileSync(target, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    if (error && error.code === "ENOENT") return fallback;
    throw new FleetMailError(`corrupt mail store: ${target}`, "corrupt");
  }
}

function compactBody(body) {
  if (body === undefined || body === null) return "";
  const text = String(body).trim();
  if (text.length <= MAX_BODY) return text;
  return `${text.slice(0, MAX_BODY - 1)}…`;
}

function newId() {
  return `${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}`;
}

function checkRateLimit(runtimeRoot, from, to, type, options) {
  if (type === "status") return; // status slots replace; not rate-limited as spam
  const limit = options.rateLimit ?? DEFAULT_RATE_LIMIT;
  const windowMs = options.rateWindowMs ?? DEFAULT_RATE_WINDOW_MS;
  const file = ratePath(runtimeRoot, from, to);
  ensureDir(path.dirname(file));
  const now = Date.now();
  const state = readJson(file, { hits: [] });
  const hits = (Array.isArray(state.hits) ? state.hits : []).filter((ts) => now - ts < windowMs);
  if (hits.length >= limit) {
    throw new FleetMailError(
      `rate limit: max ${limit} non-status messages per ${Math.round(windowMs / 1000)}s from ${from} → ${to}`,
      "rate_limit",
    );
  }
  hits.push(now);
  atomicWriteJson(file, { hits });
}

function loadInbox(runtimeRoot, mailbox) {
  const file = inboxPath(runtimeRoot, mailbox);
  const data = readJson(file, { version: 1, messages: [] });
  if (!data || !Array.isArray(data.messages)) {
    throw new FleetMailError(`corrupt inbox: ${mailbox}`, "corrupt");
  }
  return data;
}

function saveInbox(runtimeRoot, mailbox, data) {
  atomicWriteJson(inboxPath(runtimeRoot, mailbox), data);
}

/**
 * @param {object} input
 * @param {string} input.from
 * @param {string} input.to
 * @param {string} input.type
 * @param {string} [input.body]
 * @param {string} [input.ticket]
 * @param {string} [input.pr]
 * @param {string} [input.head]
 * @param {object} [options]
 */
function sendMessage(input, options = {}) {
  const env = options.env || process.env;
  const runtimeRoot = options.runtimeRoot || resolveRuntimeRoot(env);
  const from = normalizeMailbox(input.from);
  const to = normalizeMailbox(input.to);
  const type = String(input.type || "").toLowerCase();
  if (!MESSAGE_TYPES.includes(type)) {
    throw new FleetMailError(
      `type must be one of ${MESSAGE_TYPES.join("|")}`,
      "bad_type",
    );
  }

  assertTopology(from, to);

  const ticket = input.ticket ? String(input.ticket).trim() : undefined;
  if (type === "status" && !ticket) {
    throw new FleetMailError("status messages require --ticket for replaceable slots", "bad_ticket");
  }

  const message = {
    id: options.id || newId(),
    from,
    to,
    type,
    body: compactBody(input.body),
    ticket: ticket || undefined,
    pr: input.pr ? String(input.pr).trim() : undefined,
    head: input.head ? String(input.head).trim() : undefined,
    ts: options.ts || new Date().toISOString(),
    acked: false,
  };

  ensureDir(mailRoot(runtimeRoot));
  ensureDir(mailboxDir(runtimeRoot, to));

  const lock = path.join(mailboxDir(runtimeRoot, to), ".lock");
  return withLock(lock, () => {
    checkRateLimit(runtimeRoot, from, to, type, options);
    const inbox = loadInbox(runtimeRoot, to);
    let replaced = null;

    if (type === "status" && ticket) {
      const idx = inbox.messages.findIndex(
        (m) =>
          m &&
          m.type === "status" &&
          m.acked === false &&
          m.from === from &&
          m.ticket === ticket,
      );
      if (idx >= 0) {
        replaced = inbox.messages[idx].id;
        inbox.messages[idx] = message;
      } else {
        inbox.messages.push(message);
      }
    } else {
      inbox.messages.push(message);
    }

    // Keep inbox bounded: drop acked messages older than 500 tail, keep all unacked.
    if (inbox.messages.length > 1000) {
      const unacked = inbox.messages.filter((m) => !m.acked);
      const acked = inbox.messages.filter((m) => m.acked).slice(-200);
      inbox.messages = [...acked, ...unacked];
    }

    saveInbox(runtimeRoot, to, inbox);
    return { message, replaced };
  });
}

function listInbox(mailbox, options = {}) {
  const env = options.env || process.env;
  const runtimeRoot = options.runtimeRoot || resolveRuntimeRoot(env);
  const id = normalizeMailbox(mailbox);
  ensureDir(mailboxDir(runtimeRoot, id));
  const inbox = loadInbox(runtimeRoot, id);
  let messages = inbox.messages.slice();
  if (options.unread) messages = messages.filter((m) => !m.acked);
  if (options.type) messages = messages.filter((m) => m.type === options.type);
  if (options.ticket) messages = messages.filter((m) => m.ticket === options.ticket);
  if (options.from) messages = messages.filter((m) => m.from === normalizeMailbox(options.from));
  // newest last for chat-like read; allow reverse
  if (options.newestFirst) messages = messages.slice().reverse();
  if (typeof options.limit === "number") messages = messages.slice(-options.limit);
  return messages;
}

function showMessage(mailbox, options = {}) {
  const messages = listInbox(mailbox, { ...options, unread: options.unread !== false });
  if (options.id) {
    const found = listInbox(mailbox, { ...options, unread: false }).find((m) => m.id === options.id);
    if (!found) throw new FleetMailError(`message not found: ${options.id}`, "not_found");
    return found;
  }
  return messages.length ? messages[messages.length - 1] : null;
}

function ackMessages(mailbox, ids, options = {}) {
  const env = options.env || process.env;
  const runtimeRoot = options.runtimeRoot || resolveRuntimeRoot(env);
  const id = normalizeMailbox(mailbox);
  const want = new Set((Array.isArray(ids) ? ids : [ids]).map(String));
  if (want.size === 0) throw new FleetMailError("ack requires at least one id", "bad_ack");

  const lock = path.join(mailboxDir(runtimeRoot, id), ".lock");
  return withLock(lock, () => {
    const inbox = loadInbox(runtimeRoot, id);
    const acked = [];
    for (const message of inbox.messages) {
      if (want.has(message.id) && !message.acked) {
        message.acked = true;
        message.ackedAt = new Date().toISOString();
        acked.push(message.id);
      }
    }
    if (acked.length === 0) {
      throw new FleetMailError("no matching unacked messages", "not_found");
    }
    saveInbox(runtimeRoot, id, inbox);
    return { acked };
  });
}

function maybeNotifyCmux(mailbox, message, options = {}) {
  if (!options.notify) return null;
  // Optional best-effort: never required for mail delivery.
  const surface = options.notifySurface || process.env.FLEET_MAIL_NOTIFY_SURFACE;
  if (!surface) return { skipped: true, reason: "no notify surface" };
  try {
    const { spawnSync } = require("node:child_process");
    const text = `[fleet-mail] ${message.from}→${mailbox} ${message.type}${message.ticket ? ` ${message.ticket}` : ""}: ${message.body.slice(0, 120)}`;
    const result = spawnSync("cmux", ["send", "--surface", surface, text], {
      encoding: "utf8",
      timeout: 3000,
    });
    return { ok: result.status === 0, status: result.status, stderr: result.stderr };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function formatMessageLine(message) {
  const flags = message.acked ? "acked" : "unread";
  const ticket = message.ticket ? ` ticket=${message.ticket}` : "";
  const pr = message.pr ? ` pr=${message.pr}` : "";
  const head = message.head ? ` head=${message.head}` : "";
  return `${message.id} [${flags}] ${message.ts} ${message.from}→${message.to} type=${message.type}${ticket}${pr}${head} ${message.body}`;
}

module.exports = {
  MESSAGE_TYPES,
  BASE_ROLES,
  FleetMailError,
  resolveRuntimeRoot,
  normalizeMailbox,
  baseRole,
  assertTopology,
  sendMessage,
  listInbox,
  showMessage,
  ackMessages,
  maybeNotifyCmux,
  formatMessageLine,
};
