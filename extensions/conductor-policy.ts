import {
  isToolCallEventType,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { evaluateCommand } from "../bin/lib/conductor-command-policy.mjs";

/**
 * Immutable top-level Pi conductor boundary.
 *
 * pi-permission-system supplies the command policy and audit log. This second gate prevents a
 * caller-project config from weakening that policy and rejects write-capable shell syntax that
 * the permission system's access-mode-blind `path` surface cannot distinguish from reads.
 */
export default function conductorPolicy(pi: ExtensionAPI): void {
  pi.on("before_agent_start", () => {
    // A true bash "*": deny is required at runtime, but pi-permission-system consequently hides
    // the Bash tool during its earlier handler. Re-enable it after that filter; both runtime gates
    // still execute for every call.
    const active = pi.getActiveTools();
    if (!active.includes("bash")) pi.setActiveTools([...active, "bash"]);
  });

  pi.on("tool_call", (event, ctx) => {
    if (!isToolCallEventType("bash", event)) return;
    const decision = evaluateCommand(event.input.command, {
      seat: "conductor",
      cwd: ctx.cwd,
    });
    if (!decision.allowed) {
      return {
        block: true,
        reason: `Blocked by conductor policy: ${decision.reason}.`,
      };
    }
  });
}
