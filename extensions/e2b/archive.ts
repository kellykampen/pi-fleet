import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Path the runner reads the uploaded source archive from inside the sandbox. */
export const REPO_SOURCE_ARCHIVE_PATH = "/work/repo-src.tar.gz.b64";

/** Cap the captured archive at 512MiB; large enough for any real cast target. */
const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;

export type RepoArchiveMethod = "git-archive";

export interface RepoArchiveResult {
	/** Base64-encoded gzip tarball of the source tree. */
	base64: string;
	/** Which packaging method actually produced the archive. */
	method: RepoArchiveMethod;
}

export interface BuildRepoSourceArchiveOptions {
	/** Directory containing the Git checkout. Defaults to the current directory. */
	cwd?: string;
	/** Local Git ref to archive. Defaults to "HEAD". */
	ref?: string;
}

/**
 * Package a resolved Git commit into a gzip tarball for upload into the sandbox,
 * so codeAccess=clone never needs the sandbox to hold read credentials for the
 * target repo (FLT-9). Only content tracked in the selected commit is shipped.
 * Missing refs, non-Git directories, and archive failures fail closed rather
 * than falling back to packaging the working tree.
 */
export async function buildRepoSourceArchive(
	options: BuildRepoSourceArchiveOptions = {},
): Promise<RepoArchiveResult> {
	const cwd = options.cwd ?? process.cwd();
	const ref = options.ref?.trim() || "HEAD";
	let commit: string;
	try {
		const { stdout } = await execFileAsync(
			"git",
			["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`],
			{ cwd, encoding: "utf8", maxBuffer: 1024 * 1024 },
		);
		commit = stdout.trim();
		if (!/^[0-9a-f]{40,64}$/i.test(commit))
			throw new Error("Git returned an invalid commit ID");
	} catch (error) {
		throw new Error(`Unable to resolve Git ref ${ref} for source archive`, {
			cause: error,
		});
	}

	try {
		const { stdout } = await execFileAsync(
			"git",
			["archive", "--format=tar.gz", commit],
			{ cwd, encoding: "buffer", maxBuffer: MAX_ARCHIVE_BYTES },
		);
		return { base64: stdout.toString("base64"), method: "git-archive" };
	} catch (error) {
		throw new Error(`Unable to archive Git ref ${ref}`, { cause: error });
	}
}
