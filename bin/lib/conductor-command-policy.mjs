import { isAbsolute, normalize, relative, resolve, sep } from "node:path";

const COMMON_EXECUTABLES = new Set([
  "cmux",
  "linear-cli",
  "check-model-usage",
]);
const READ_UTILITIES = new Set([
  "cat",
  "ls",
  "grep",
  "rg",
  "head",
  "tail",
  "wc",
  "find",
  "jq",
]);
const READ_ONLY_GIT = new Set(["status", "log", "diff", "show", "rev-parse"]);
const UNSAFE_GIT_READ_OPTIONS = new Set(["--ext-diff", "--textconv", "--output"]);
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
const ALLOWED_VARIABLES = new Set(["$CMUX_WORKSPACE_ID", "${CMUX_WORKSPACE_ID}"]);

function denied(reason) {
  return { allowed: false, reason };
}

/**
 * Parse one deliberately small shell-command subset.
 *
 * Quoted control characters are argument text (needed for `cmux send`), while
 * shell control flow, redirects, substitutions, wrappers, and uncertainty fail
 * closed. This is a policy parser, not a general shell parser.
 */
function tokenizeAtomicCommand(command) {
  if (typeof command !== "string" || command.trim() === "") {
    return { error: "empty command" };
  }
  if (command.includes("$(") || command.includes("`")) {
    return { error: "command substitution is not allowed" };
  }

  const tokens = [];
  let token = "";
  let quote = null;
  let escaping = false;
  let tokenStarted = false;

  const push = () => {
    if (tokenStarted) tokens.push(token);
    token = "";
    tokenStarted = false;
  };

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (escaping) {
      token += char;
      tokenStarted = true;
      escaping = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaping = true;
      tokenStarted = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      else token += char;
      tokenStarted = true;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      tokenStarted = true;
      continue;
    }
    if (/\s/u.test(char)) {
      if (char === "\n" || char === "\r") {
        return { error: "compound commands are not allowed" };
      }
      push();
      continue;
    }
    if (";&|<>()".includes(char) || char === "#") {
      return { error: "shell control flow and redirects are not allowed" };
    }
    token += char;
    tokenStarted = true;
  }

  if (escaping || quote) return { error: "command could not be parsed safely" };
  push();
  if (tokens.length === 0) return { error: "empty command" };
  return { tokens };
}

function hasUnsafeVariable(tokens) {
  return tokens.some((token, index) => {
    if (!token.includes("$")) return false;
    if (index > 0 && ALLOWED_VARIABLES.has(token)) return false;
    return true;
  });
}

function allowGitRead(args) {
  let cursor = 0;
  if (args[0] === "-C") {
    if (!args[1] || args[1].startsWith("-")) return false;
    cursor = 2;
  }
  const subcommand = args[cursor];
  const rest = args.slice(cursor + 1);
  const unsafeReadOption = rest.some(
    (arg) => UNSAFE_GIT_READ_OPTIONS.has(arg) || arg.startsWith("--output="),
  );
  if (READ_ONLY_GIT.has(subcommand)) return !unsafeReadOption;
  if (subcommand !== "branch") return false;
  return rest.length === 0 || rest[0] === "--list";
}

function isInsideWorktreeRoot(pathValue, cwd) {
  if (!pathValue || isAbsolute(pathValue)) return false;
  const parts = normalize(pathValue).split(/[\\/]/u);
  if (parts.includes("..")) return false;
  const worktreeRoot = resolve(cwd, ".worktrees");
  const candidate = resolve(cwd, pathValue);
  const rel = relative(worktreeRoot, candidate);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function worktreePath(args, operation) {
  const optionWithValue = new Set(["-b", "-B", "--reason"]);
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (optionWithValue.has(token)) {
      index += 1;
      continue;
    }
    if (token.startsWith("-")) continue;
    return token;
  }
  return undefined;
}

const FORBIDDEN_GIT_EXEC_OPTIONS = ["--upload-pack", "--receive-pack", "--exec"];
const FETCH_OPTIONS = new Set(["--prune", "--tags", "--no-tags", "--force", "--quiet", "--verbose", "--dry-run", "-p", "-t", "-f", "-q", "-v"]);
const PULL_OPTIONS = new Set(["--ff-only", "--quiet", "--verbose", "--dry-run", "-q", "-v"]);
const PUSH_OPTIONS = new Set(["--dry-run", "--porcelain", "--quiet", "--verbose", "-n", "-q", "-v"]);
const MERGE_OPTIONS = new Set(["--no-edit", "--ff-only", "--no-ff", "--squash", "--commit", "--no-commit", "--quiet", "--verbose", "--stat", "--no-stat", "-q", "-v"]);

function hasGitExecutableOption(args) {
  return args.some((arg) =>
    FORBIDDEN_GIT_EXEC_OPTIONS.some((option) => arg === option || arg.startsWith(`${option}=`)) ||
    arg === "-u" || arg.startsWith("-u=") || /^-u[^-]/u.test(arg)
  );
}

function isSafeGitRef(value) {
  return (
    typeof value === "string" &&
    !value.startsWith("-") &&
    !value.includes("..") &&
    !value.includes("::") &&
    /^(?:\+)?[A-Za-z0-9][A-Za-z0-9._/-]*(?::[A-Za-z0-9][A-Za-z0-9._/-]*)?$/u.test(value)
  );
}

function parseOriginOperation(args, allowedOptions) {
  const refs = [];
  let sawOrigin = false;
  for (const arg of args) {
    if (allowedOptions.has(arg)) continue;
    if (arg.startsWith("-")) return undefined;
    if (!sawOrigin) {
      if (arg !== "origin") return undefined;
      sawOrigin = true;
      continue;
    }
    if (!isSafeGitRef(arg)) return undefined;
    refs.push(arg);
  }
  return sawOrigin ? refs : undefined;
}

function allowLeadGit(args, cwd) {
  const subcommand = args[0];
  const rest = args.slice(1);
  if (hasGitExecutableOption(rest)) return false;
  if (subcommand === "checkout" || subcommand === "switch") {
    return rest.length === 1 && rest[0] === "main";
  }
  if (subcommand === "fetch") {
    return parseOriginOperation(rest, FETCH_OPTIONS) !== undefined;
  }
  if (subcommand === "pull") {
    const refs = parseOriginOperation(rest, PULL_OPTIONS);
    return rest.includes("--ff-only") && refs !== undefined && refs.length <= 1;
  }
  if (subcommand === "push") {
    const refs = parseOriginOperation(rest, PUSH_OPTIONS);
    return refs !== undefined && refs.length === 1;
  }
  if (subcommand === "merge") {
    const refs = rest.filter((arg) => !MERGE_OPTIONS.has(arg));
    return rest.every((arg) => MERGE_OPTIONS.has(arg) || isSafeGitRef(arg)) && refs.length === 1;
  }
  if (subcommand !== "worktree") return false;

  const operation = rest[0];
  const operationArgs = rest.slice(1);
  if (operation === "list") return true;
  if (operation !== "add" && operation !== "remove") return false;
  return isInsideWorktreeRoot(worktreePath(operationArgs, operation), cwd);
}

function allowGh(args, seat) {
  if (args[0] === "issue" && args[1] === "view") return true;
  if (args[0] !== "pr") return false;
  if (["view", "list", "checks"].includes(args[1])) return true;
  if (seat === "lead" && ["merge", "comment"].includes(args[1])) return true;
  return false;
}

const ORCHESTRATION_DOCUMENTS = new Set([
  ".claude/orchestration/ORCHESTRATION-HANDOFF.md",
  ".claude/orchestration/MORNING-ESCALATIONS.md",
  ".claude/orchestration/ORCHESTRATOR-PLAYBOOK.md",
]);

function allowedCoordinationPath(pathValue) {
  if (!pathValue || isAbsolute(pathValue) || pathValue.includes("\\")) return false;
  const parts = normalize(pathValue).split("/");
  if (parts.includes("..")) return false;
  const normalizedPath = parts.join("/");
  return ORCHESTRATION_DOCUMENTS.has(normalizedPath) || (parts[0] === "coordination" && parts.length > 1);
}

function allowFleetNote(tokens) {
  return (
    tokens.length === 4 &&
    ["append", "write"].includes(tokens[1]) &&
    allowedCoordinationPath(tokens[2])
  );
}

const FLEET_MAIL_COMMANDS = new Set(["send", "inbox", "show", "ack", "help"]);
const FLEET_MAIL_FLAGS = new Set([
  "--from",
  "--to",
  "--type",
  "--ticket",
  "--pr",
  "--head",
  "--body",
  "--mailbox",
  "--id",
  "--unread",
  "--json",
  "--limit",
  "--newest-first",
  "--notify",
  "--help",
  "-h",
]);

function allowFleetMail(tokens) {
  if (tokens.length < 2) return tokens.length === 1;
  const sub = tokens[1];
  if (!FLEET_MAIL_COMMANDS.has(sub)) return false;
  // Lead/conductor may invoke fleet-mail for coordination only; topology is enforced inside the CLI.
  for (let index = 2; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.startsWith("--")) {
      const eq = token.indexOf("=");
      const flag = eq === -1 ? token : token.slice(0, eq);
      if (!FLEET_MAIL_FLAGS.has(flag)) return false;
      if (eq === -1 && index + 1 < tokens.length && !tokens[index + 1].startsWith("--")) {
        // value token consumed loosely; reject shell metachar already handled by tokenizer
        index += 1;
      }
      continue;
    }
    // positional body text is allowed for send
    if (sub !== "send" && sub !== "help") return false;
  }
  return true;
}

export function evaluateCommand(command, options = {}) {
  const { seat, cwd = process.cwd() } = options;
  if (seat !== "conductor" && seat !== "lead") return denied("unknown seat policy");

  const parsed = tokenizeAtomicCommand(command);
  if (parsed.error) return denied(parsed.error);
  const tokens = parsed.tokens;
  if (hasUnsafeVariable(tokens)) return denied("unapproved variable expansion");

  const executable = tokens[0];
  const args = tokens.slice(1);
  if (COMMON_EXECUTABLES.has(executable)) return { allowed: true };
  if (READ_UTILITIES.has(executable)) {
    if (executable === "find" && args.some((arg) => UNSAFE_FIND_ACTIONS.has(arg))) {
      return denied("find mutation and execution actions are not allowed");
    }
    return { allowed: true };
  }
  if (executable === "fleet-note") {
    return allowFleetNote(tokens) ? { allowed: true } : denied("fleet-note target or arguments are not allowed");
  }
  if (executable === "fleet-mail") {
    return allowFleetMail(tokens) ? { allowed: true } : denied("fleet-mail arguments are not allowed");
  }
  if (executable === "gh") {
    return allowGh(args, seat) ? { allowed: true } : denied("GitHub command is outside the seat allowlist");
  }
  if (executable === "git") {
    if (allowGitRead(args)) return { allowed: true };
    if (seat === "lead" && allowLeadGit(args, cwd)) return { allowed: true };
    return denied("Git command is outside the seat allowlist");
  }
  if (executable === "uptime" && args.length === 0) return { allowed: true };
  return denied("command executable is outside the seat allowlist");
}
