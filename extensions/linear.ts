import { defineTool, type AgentToolResult, type ExecResult, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";

function stdoutResult(result: ExecResult): AgentToolResult<{ code: number; stderr: string }> {
	if (result.code !== 0) {
		throw new Error(result.stderr || result.stdout || `linear-cli exited with code ${result.code}`);
	}

	return {
		content: [{ type: "text", text: result.stdout }],
		details: { code: result.code, stderr: result.stderr },
	};
}

export default function (pi: ExtensionAPI) {
	pi.registerTool(defineTool({
		name: "linear_get_issue",
		label: "Linear: get issue",
		description: "Fetch one Linear issue by ID or identifier and return JSON.",
		promptSnippet: "linear_get_issue: fetch one Linear issue by ID/identifier as JSON.",
		parameters: Type.Object({
			id: Type.String({ description: "Linear issue ID or identifier, e.g. SID-1" }),
		}),
		async execute(_toolCallId, params, signal) {
			const result = await pi.exec("linear-cli", [
				"issues",
				"get",
				"--output",
				"json",
				"--no-color",
				"--no-pager",
				params.id,
			], { signal });
			return stdoutResult(result);
		},
	}));

	pi.registerTool(defineTool({
		name: "linear_list",
		label: "Linear: list/search issues",
		description: "List Linear issues, or search issues by query when query is provided. Returns JSON.",
		promptSnippet: "linear_list: list Linear issues or search by query as JSON.",
		parameters: Type.Object({
			query: Type.Optional(Type.String({ description: "Search query. If omitted, lists issues." })),
			limit: Type.Optional(Type.Number({ description: "Maximum number of issues to return." })),
		}),
		async execute(_toolCallId, params, signal) {
			const limit = params.limit === undefined ? undefined : Math.max(1, Math.floor(params.limit));
			const args = params.query && params.query.trim().length > 0
				? ["search", "issues", "--output", "json", "--no-color", "--no-pager"]
				: ["issues", "list", "--output", "json", "--no-color", "--no-pager"];
			if (limit !== undefined) args.push("--limit", String(limit));
			if (params.query && params.query.trim().length > 0) args.push(params.query);

			const result = await pi.exec("linear-cli", args, { signal });
			return stdoutResult(result);
		},
	}));

	pi.registerTool(defineTool({
		name: "linear_comment",
		label: "Linear: comment on issue",
		description: "Add a Markdown comment to a Linear issue. This is a write operation.",
		promptSnippet: "linear_comment: add a comment to a Linear issue (write operation).",
		parameters: Type.Object({
			id: Type.String({ description: "Linear issue ID or identifier, e.g. SID-1" }),
			body: Type.String({ description: "Markdown comment body." }),
		}),
		async execute(_toolCallId, params, signal) {
			const result = await pi.exec("linear-cli", [
				"comments",
				"create",
				"--output",
				"json",
				"--no-color",
				"--no-pager",
				"--body",
				params.body,
				params.id,
			], { signal });
			return stdoutResult(result);
		},
	}));

	pi.registerTool(defineTool({
		name: "linear_update",
		label: "Linear: update issue",
		description: "Update a Linear issue status and/or assignee. This is a write operation.",
		promptSnippet: "linear_update: update a Linear issue status and/or assignee (write operation).",
		parameters: Type.Object({
			id: Type.String({ description: "Linear issue ID or identifier, e.g. SID-1" }),
			status: Type.Optional(Type.String({ description: "New state/status name or ID." })),
			assignee: Type.Optional(Type.String({ description: "New assignee user ID, name, email, or 'me'." })),
		}),
		async execute(_toolCallId, params, signal) {
			const args = ["issues", "update", "--output", "json", "--no-color", "--no-pager"];
			if (params.status !== undefined) args.push("--state", params.status);
			if (params.assignee !== undefined) args.push("--assignee", params.assignee);
			if (args.length === 6) {
				throw new Error("linear_update requires at least one of status or assignee.");
			}
			args.push(params.id);

			const result = await pi.exec("linear-cli", args, { signal });
			return stdoutResult(result);
		},
	}));
}
