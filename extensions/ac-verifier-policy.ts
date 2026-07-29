import {
	isToolCallEventType,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { evaluateAcVerifierCommand } from "../bin/lib/ac-verifier-command-policy.mjs";

/**
 * Immutable AC-verifier Bash boundary.
 *
 * The verifier has bash so it can run real validation commands, but it must not edit code,
 * push, or mutate a PR beyond posting evidence comments through the dedicated github_pr_comment
 * tool. This policy blocks shell control flow/redirects and rejects Git writes and raw
 * `gh pr comment` so mutation flags such as --edit-last/--delete-last never enter through Bash.
 */
export default function acVerifierPolicy(pi: ExtensionAPI): void {
	pi.on("tool_call", (event) => {
		if (!isToolCallEventType("bash", event)) return;
		const decision = evaluateAcVerifierCommand(event.input.command);
		if (!decision.allowed) {
			return {
				block: true,
				reason: `Blocked by AC-verifier policy: ${decision.reason}.`,
			};
		}
	});
}
