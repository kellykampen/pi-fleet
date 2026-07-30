import {
  isToolCallEventType,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { evaluateLinearSeatCommand } from "../bin/lib/linear-seat-command-policy.mjs";

/**
 * Immutable spike-breakdown bash boundary (FLT-67).
 *
 * Spike-breakdown keeps bash for linear-cli + pi-fleet-spike-interview but must
 * never mutate repo source. Always-YOLO removes interactive confirmations —
 * this gate is the fail-closed boundary.
 */
export default function spikeBreakdownPolicy(pi: ExtensionAPI): void {
  pi.on("tool_call", (event) => {
    if (!isToolCallEventType("bash", event)) return;
    const decision = evaluateLinearSeatCommand(event.input.command);
    if (!decision.allowed) {
      return {
        block: true,
        reason: `Blocked by spike-breakdown policy: ${decision.reason}.`,
      };
    }
  });
}
