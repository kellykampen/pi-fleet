import {
	defineTool,
	type AgentToolResult,
	type ExecResult,
	type ExtensionAPI,
} from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";

function stdoutResult(
	result: ExecResult,
): AgentToolResult<{ code: number; stderr: string }> {
	if (result.code !== 0) {
		throw new Error(
			result.stderr || result.stdout || `gh exited with code ${result.code}`,
		);
	}
	return {
		content: [{ type: "text", text: result.stdout }],
		details: { code: result.code, stderr: result.stderr },
	};
}

function repoArgs(repo?: string): string[] {
	return repo && repo.trim().length > 0 ? ["--repo", repo] : [];
}

function prSelector(pr: string): string {
	const selector = pr.trim();
	if (selector.length === 0 || selector.startsWith("-")) {
		throw new Error(
			"PR selector must be a non-empty PR number, URL, or branch and must not start with '-'.",
		);
	}
	return selector;
}

export default function githubPr(pi: ExtensionAPI): void {
	pi.registerTool(
		defineTool({
			name: "github_pr_view",
			label: "GitHub: view PR metadata",
			description:
				"Fetch PR metadata needed for AC verification: body, head SHA, branch, URL, title, and state. Read-only.",
			promptSnippet:
				"github_pr_view: read PR body/head SHA for AC verification.",
			parameters: Type.Object({
				pr: Type.String({
					description: "Pull request number, URL, or branch.",
				}),
				repo: Type.Optional(
					Type.String({
						description:
							"GitHub repo in owner/name form. Defaults to current repo.",
					}),
				),
			}),
			async execute(_toolCallId, params, signal) {
				const pr = prSelector(params.pr);
				const result = await pi.exec(
					"gh",
					[
						"pr",
						"view",
						pr,
						...repoArgs(params.repo),
						"--json",
						"number,title,url,state,body,headRefName,headRefOid,baseRefName",
					],
					{ signal },
				);
				return stdoutResult(result);
			},
		}),
	);

	pi.registerTool(
		defineTool({
			name: "github_pr_comment",
			label: "GitHub: comment on PR",
			description:
				"Post an AC verification evidence comment to a GitHub PR. Comment-only: does not approve, request changes, merge, push, or edit code.",
			promptSnippet:
				"github_pr_comment: post AC verification evidence to the PR as a plain comment (no review/merge authority).",
			parameters: Type.Object({
				pr: Type.String({
					description: "Pull request number, URL, or branch.",
				}),
				body: Type.String({ description: "Markdown evidence comment body." }),
				repo: Type.Optional(
					Type.String({
						description:
							"GitHub repo in owner/name form. Defaults to current repo.",
					}),
				),
			}),
			async execute(_toolCallId, params, signal) {
				const pr = prSelector(params.pr);
				const result = await pi.exec(
					"gh",
					[
						"pr",
						"comment",
						pr,
						...repoArgs(params.repo),
						"--body",
						params.body,
					],
					{ signal },
				);
				return stdoutResult(result);
			},
		}),
	);
}
