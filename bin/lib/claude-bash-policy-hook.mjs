import { evaluateCommand } from "./conductor-command-policy.mjs";

const seat = process.argv[2];
let raw = "";
for await (const chunk of process.stdin) raw += chunk;

let payload;
try {
  payload = JSON.parse(raw);
} catch {
  process.stderr.write("Blocked by fleet command policy: malformed hook input.\n");
  process.exit(2);
}

if (payload?.tool_name !== "Bash" || typeof payload?.tool_input?.command !== "string") {
  process.stderr.write("Blocked by fleet command policy: missing Bash command.\n");
  process.exit(2);
}

const decision = evaluateCommand(payload.tool_input.command, {
  seat,
  cwd: typeof payload.cwd === "string" ? payload.cwd : process.cwd(),
});
if (!decision.allowed) {
  process.stderr.write(`Blocked by ${seat ?? "unknown"} policy: ${decision.reason}.\n`);
  process.exit(2);
}
