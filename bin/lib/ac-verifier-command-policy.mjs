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
const SAFE_PNPM_SCRIPTS = new Set(["test", "lint", "typecheck", "build"]);
const SAFE_NPM_SCRIPTS = new Set(["test", "run"]);
const SAFE_NPM_RUN_TARGETS = new Set(["test", "lint", "typecheck", "build"]);
const SAFE_NODE_FLAGS = new Set(["--check", "--test"]);

function denied(reason) {
	return { allowed: false, reason };
}

function tokenizeAtomicCommand(command) {
	if (typeof command !== "string" || command.trim() === "")
		return { error: "empty command" };
	if (command.includes("$(") || command.includes("`"))
		return { error: "command substitution is not allowed" };

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
			if (char === "\n" || char === "\r")
				return { error: "compound commands are not allowed" };
			push();
			continue;
		}
		if (";&|<>()".includes(char) || char === "#")
			return { error: "shell control flow and redirects are not allowed" };
		token += char;
		tokenStarted = true;
	}

	if (escaping || quote) return { error: "command could not be parsed safely" };
	push();
	return tokens.length > 0 ? { tokens } : { error: "empty command" };
}

function allowGit(args) {
	let cursor = 0;
	if (args[0] === "-C") {
		if (!args[1] || args[1].startsWith("-")) return false;
		cursor = 2;
	}
	const subcommand = args[cursor];
	const rest = args.slice(cursor + 1);
	if (READ_ONLY_GIT.has(subcommand))
		return !rest.some(
			(arg) => arg === "--output" || arg.startsWith("--output="),
		);
	if (subcommand === "branch") return rest.length === 0 || rest[0] === "--list";
	return false;
}

function allowGh(args) {
	if (args[0] === "issue" && args[1] === "view") return true;
	if (args[0] !== "pr") return false;
	if (["view", "list", "checks", "diff"].includes(args[1])) return true;
	// Evidence comments must use the dedicated github_pr_comment tool, not raw Bash. This keeps
	// mutation flags like --edit-last/--delete-last out of the Bash surface entirely.
	return false;
}

function isArgumentLikeScriptName(value) {
	return typeof value === "string" && value.length > 0 && !value.startsWith("-") && !value.includes("/");
}

function allowPnpm(args) {
	if (args.length === 0) return false;
	if (args[0] === "exec") return false;
	return SAFE_PNPM_SCRIPTS.has(args[0]);
}

function allowNpm(args) {
	if (args.length === 0 || !SAFE_NPM_SCRIPTS.has(args[0])) return false;
	if (args[0] === "test") return true;
	const target = args[1];
	return isArgumentLikeScriptName(target) && SAFE_NPM_RUN_TARGETS.has(target);
}

function allowNode(args) {
	return args.length >= 2 && SAFE_NODE_FLAGS.has(args[0]) && !args[1].startsWith("-");
}

export function evaluateAcVerifierCommand(command) {
	const parsed = tokenizeAtomicCommand(command);
	if (parsed.error) return denied(parsed.error);
	const tokens = parsed.tokens ?? [];
	const executable = tokens[0];
	const args = tokens.slice(1);

	if (READ_UTILITIES.has(executable)) {
		if (
			executable === "find" &&
			args.some((arg) => UNSAFE_FIND_ACTIONS.has(arg))
		) {
			return denied("find mutation and execution actions are not allowed");
		}
		return { allowed: true };
	}
	if (executable === "git")
		return allowGit(args)
			? { allowed: true }
			: denied("Git command is outside the AC-verifier allowlist");
	if (executable === "gh")
		return allowGh(args)
			? { allowed: true }
			: denied("GitHub command is outside the AC-verifier allowlist");
	if (executable === "linear-cli") return { allowed: true };
	if (executable === "pnpm") return allowPnpm(args) ? { allowed: true } : denied("pnpm command is outside the AC-verifier allowlist");
	if (executable === "npm") return allowNpm(args) ? { allowed: true } : denied("npm command is outside the AC-verifier allowlist");
	if (executable === "node") return allowNode(args) ? { allowed: true } : denied("node command is outside the AC-verifier allowlist");
	return denied("command executable is outside the AC-verifier allowlist");
}
