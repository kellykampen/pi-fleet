import {
  isToolCallEventType,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { evaluateCommand } from "../bin/lib/conductor-command-policy.mjs";

/**
 * Immutable top-level Pi project-lead boundary.
 *
 * Mirrors the conductor gate (FLT-52) with seat "lead": coordination, casting, PR/status, and
 * narrow main-integration git/gh verbs remain available; source mutation, builds, installs,
 * arbitrary scripts, and reviewer-only actions fail closed. The permission system supplies the
 * command policy and audit log; this second gate prevents a caller-project config from weakening
 * that policy and rejects write-capable shell syntax the permission path surface cannot distinguish
 * from reads.
 */
export default function projectLeadPolicy(pi: ExtensionAPI): void {
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
      seat: "lead",
      cwd: ctx.cwd,
    });
    if (!decision.allowed) {
      return {
        block: true,
        reason: `Blocked by project-lead policy: ${decision.reason}.`,
      };
    }
  });
}
