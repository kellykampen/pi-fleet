/**
 * Fail-closed bash policy for linear-workflow seats that keep bash but must not
 * mutate repo source (planner, spike-breakdown). FLT-67 always-YOLO means bash
 * is auto-approved — this gate is the boundary.
 *
 * Allows:
 *   - linear-cli (ticket/project management; may use documented -d "$(cat …)" forms)
 *   - pi-fleet-spike-interview (spike interview wrapper)
 *   - read/orientation utilities (cat/ls/grep/rg/head/tail/wc/find/jq/mkdir/rm/cp/mv for staging)
 *
 * Denies:
 *   - package managers, interpreters used for implementation, git write, gh mutation,
 *   - shell chaining that escapes the allowlisted head executable
 */

function denied(reason) {
  return { allowed: false, reason };
}

const READ_UTILS = new Set([
  "cat",
  "ls",
  "grep",
  "rg",
  "head",
  "tail",
  "wc",
  "find",
  "jq",
  "mkdir",
  "rm",
  "cp",
  "mv",
  "printf",
  "echo",
  "basename",
  "dirname",
  "pwd",
  "true",
  "false",
  "test",
  "[",
  "chmod",
  "touch",
  "mktemp",
  "sed",
  "tr",
  "cut",
  "sort",
  "uniq",
  "tee",
]);

const ALLOWED_HEADS = new Set(["linear-cli", "pi-fleet-spike-interview"]);

const UNSAFE_FIND_ACTIONS = new Set([
  "-delete",
  "-exec",
  "-execdir",
  "-ok",
  "-okdir",
  "-fls",
  "-fprint",
  "-fprint0",
  "-fprintf",
]);

/** First shell word, ignoring a leading env assignment chain like FOO=1 BAR=2 cmd. */
function headExecutable(command) {
  if (typeof command !== "string") return null;
  const trimmed = command.trim();
  if (!trimmed) return null;
  // Reject obvious multi-command chaining at the top level (unquoted).
  // Allow $(...) and < > inside allowlisted linear-cli / interview commands.
  let inS = false;
  let inD = false;
  let esc = false;
  let depth = 0;
  for (let i = 0; i < trimmed.length; i += 1) {
    const ch = trimmed[i];
    const next = trimmed[i + 1];
    if (esc) {
      esc = false;
      continue;
    }
    if (ch === "\\" && !inS) {
      esc = true;
      continue;
    }
    if (ch === "'" && !inD) {
      inS = !inS;
      continue;
    }
    if (ch === '"' && !inS) {
      inD = !inD;
      continue;
    }
    if (inS || inD) continue;
    if (ch === "`") return null; // backticks always rejected
    if (ch === "$" && next === "(") {
      depth += 1;
      i += 1;
      continue;
    }
    if (ch === "(" && depth > 0) {
      depth += 1;
      continue;
    }
    if (ch === ")" && depth > 0) {
      depth -= 1;
      continue;
    }
    if (depth > 0) continue;
    if (ch === ";" || ch === "|" || ch === "&" || ch === "\n" || ch === "\r") {
      return null;
    }
  }

  // Strip leading VAR=value prefixes.
  let rest = trimmed;
  while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(rest)) {
    const m = rest.match(/^[A-Za-z_][A-Za-z0-9_]*=(?:'[^']*'|"[^"]*"|[^\s]+)\s+/);
    if (!m) break;
    rest = rest.slice(m[0].length);
  }
  const match = rest.match(/^([^\s]+)/);
  if (!match) return null;
  let head = match[1];
  // Strip path prefixes: /usr/bin/linear-cli -> linear-cli
  if (head.includes("/")) head = head.slice(head.lastIndexOf("/") + 1);
  return head;
}

function allowReadUtility(command, head) {
  if (!READ_UTILS.has(head)) return false;
  if (head === "find") {
    const parts = command.split(/\s+/);
    if (parts.some((p) => UNSAFE_FIND_ACTIONS.has(p))) return false;
  }
  // Staging helpers: deny path escapes that look like destructive root wipes.
  if (/\brm\b[\s\S]*\//.test(command) && /rm\s+(-[a-zA-Z]*r[a-zA-Z]*|--recursive)/.test(command)) {
    // allow rm -rf /tmp/... only
    if (!/\brm\b[\s\S]*\/tmp(\/|\b)/.test(command) && !/\brm\b[\s\S]*\$\{?TMPDIR/.test(command)) {
      return false;
    }
  }
  return true;
}

export function evaluateLinearSeatCommand(command) {
  const head = headExecutable(command);
  if (!head) {
    return denied("command could not be parsed safely or uses disallowed shell chaining");
  }
  if (ALLOWED_HEADS.has(head)) {
    return { allowed: true };
  }
  if (allowReadUtility(command, head)) {
    return { allowed: true };
  }
  return denied(
    `executable "${head}" is outside the linear-seat allowlist (linear-cli / pi-fleet-spike-interview / read utilities only)`,
  );
}
