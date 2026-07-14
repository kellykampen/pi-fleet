import { isAbsolute, normalize, relative, resolve, sep } from "node:path";

const ROUTING_PROBE = ["pe", "ek"].join("");
const COMMON_EXECUTABLES = new Set([
  "cmux",
  "linear-cli",
  ROUTING_PROBE,
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

function allowLeadGit(args, cwd) {
  const subcommand = args[0];
  const rest = args.slice(1);
  if (subcommand === "checkout" || subcommand === "switch") {
    return rest.length === 1 && rest[0] === "develop";
  }
  if (subcommand === "fetch") return rest.length >= 0;
  if (subcommand === "pull") {
    return rest.includes("--ff-only") && !rest.some((arg) => arg === "--rebase" || arg === "--no-ff" || arg === "--squash");
  }
  if (subcommand === "merge") return rest.length > 0;
  if (subcommand === "push") return rest.length > 0;
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

function allowedCoordinationPath(pathValue) {
  if (!pathValue || isAbsolute(pathValue)) return false;
  const parts = normalize(pathValue).split(/[\\/]/u);
  if (parts.includes("..")) return false;
  const basename = parts.at(-1) ?? "";
  return parts[0] === "coordination" || basename.includes("HANDOFF") || basename.endsWith("ESCALATIONS.md");
}

function allowFleetNote(tokens) {
  return (
    tokens.length === 4 &&
    ["append", "write"].includes(tokens[1]) &&
    allowedCoordinationPath(tokens[2])
  );
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
  if (executable === "gh") {
    return allowGh(args, seat) ? { allowed: true } : denied("GitHub command is outside the seat allowlist");
  }
  if (executable === "git") {
    if (allowGitRead(args)) return { allowed: true };
    if (seat === "lead" && allowLeadGit(args, cwd)) return { allowed: true };
    return denied("Git command is outside the seat allowlist");
  }
  if (seat === "lead" && executable === "uptime" && args.length === 0) return { allowed: true };
  return denied("command executable is outside the seat allowlist");
}
