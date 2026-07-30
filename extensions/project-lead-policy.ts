import {
  isToolCallEventType,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { evaluateCommand } from "../bin/lib/conductor-command-policy.mjs";

/**
 * Immutable top-level Pi project-lead boundary (FLT-52 / FLT-67).
 *
 * Mirrors the conductor gate with seat "lead": coordination, casting, PR/status, and narrow
 * main-integration git/gh verbs remain available; source mutation, builds, installs, arbitrary
 * scripts, and reviewer-only actions fail closed. Security is the wrapper `--tools` allowlist
 * (no write/edit) plus this fail-closed bash command-policy gate. `@gotgenes/pi-permission-system`
 * is not loaded.
 */
export default function projectLeadPolicy(pi: ExtensionAPI): void {
  pi.on("before_agent_start", () => {
    // Ensure bash remains active when the wrapper allowlist includes it.
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
