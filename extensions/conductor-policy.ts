import {
  isToolCallEventType,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { evaluateCommand } from "../bin/lib/conductor-command-policy.mjs";

/**
 * Immutable top-level Pi conductor boundary (FLT-67).
 *
 * Security is the wrapper `--tools` allowlist (no write/edit) plus this fail-closed bash
 * command-policy gate. `@gotgenes/pi-permission-system` is not loaded. This gate rejects
 * write-capable shell syntax, compounds, and non-allowlisted executables for the conductor seat.
 */
export default function conductorPolicy(pi: ExtensionAPI): void {
  pi.on("before_agent_start", () => {
    // Ensure bash remains active when the wrapper allowlist includes it.
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
