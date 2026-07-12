import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Path the runner reads the uploaded source archive from inside the sandbox. */
export const REPO_SOURCE_ARCHIVE_PATH = "/work/repo-src.tar.gz.b64";

/** Cap the captured archive at 512MiB; large enough for any real cast target. */
const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;

export type RepoArchiveMethod = "git-archive" | "tar";

export interface RepoArchiveResult {
	/** Base64-encoded gzip tarball of the source tree. */
	base64: string;
	/** Which packaging method actually produced the archive. */
	method: RepoArchiveMethod;
}

export interface BuildRepoSourceArchiveOptions {
	/** Directory to package. Defaults to the current working directory. */
	cwd?: string;
	/** git ref to archive (git-archive path only). Defaults to "HEAD". */
	ref?: string;
}

/**
 * Package `cwd` into a gzip tarball for upload into the sandbox, so
 * codeAccess=clone never needs the sandbox to hold read credentials for the
 * target repo (FLT-9) — the host (which already has its own git access to the
 * repo it's running from) ships a source snapshot instead of having the
 * sandbox `gh repo clone` it.
 *
 * Prefers `git archive <ref>`: fast, ref-addressable, and respects tracked
 * files. Falls back to a plain `tar` of the working tree (minus `.git`) when
 * `cwd` isn't a usable git checkout for that ref (no git binary, not a repo,
 * or the ref doesn't exist locally — this never fetches from a remote).
 */
export async function buildRepoSourceArchive(
	options: BuildRepoSourceArchiveOptions = {},
): Promise<RepoArchiveResult> {
	const cwd = options.cwd ?? process.cwd();
	const ref = options.ref?.trim() || "HEAD";

	try {
		const { stdout } = await execFileAsync(
			"git",
			["archive", "--format=tar.gz", ref],
			{ cwd, encoding: "buffer", maxBuffer: MAX_ARCHIVE_BYTES },
		);
		return { base64: stdout.toString("base64"), method: "git-archive" };
	} catch {
		// Not a git checkout, ref not found locally, or git unavailable — fall
		// back to a plain tar of the working tree so codeAccess=clone still works.
	}

	const { stdout } = await execFileAsync(
		"tar",
		["--exclude=.git", "-czf", "-", "-C", cwd, "."],
		{ encoding: "buffer", maxBuffer: MAX_ARCHIVE_BYTES },
	);
	return { base64: stdout.toString("base64"), method: "tar" };
}
