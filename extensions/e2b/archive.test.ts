import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import test from "node:test";

import { buildRepoSourceArchive, REPO_SOURCE_ARCHIVE_PATH } from "./archive.ts";

/** Extract a base64 gzip-tar payload into `dest` for round-trip assertions. */
function extractBase64Tar(base64: string, dest: string): void {
	execFileSync(
		"bash",
		["-c", `base64 -d | tar -xzf - -C ${JSON.stringify(dest)}`],
		{ input: base64 },
	);
}

function listTarEntries(base64: string): string[] {
	const out = execFileSync("bash", ["-c", "base64 -d | tar -tzf -"], {
		input: base64,
	}).toString();
	return out.split("\n").filter(Boolean);
}

async function gitRepoFixture(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "pi-fleet-archive-git-"));
	execFileSync("git", ["init", "-q"], { cwd: dir });
	execFileSync("git", ["config", "user.email", "fleet@pi-fleet.local"], {
		cwd: dir,
	});
	execFileSync("git", ["config", "user.name", "pi-fleet"], { cwd: dir });
	await writeFile(join(dir, "hello.txt"), "hello from FLT-9\n");
	execFileSync("git", ["add", "-A"], { cwd: dir });
	execFileSync("git", ["commit", "-q", "-m", "initial"], { cwd: dir });
	return dir;
}

test("buildRepoSourceArchive packages a resolved git ref via git archive", async () => {
	const repo = await gitRepoFixture();
	const dest = await mkdtemp(join(tmpdir(), "pi-fleet-archive-extract-"));
	try {
		const archive = await buildRepoSourceArchive({ cwd: repo, ref: "HEAD" });

		assert.equal(archive.method, "git-archive");
		extractBase64Tar(archive.base64, dest);
		const content = await import("node:fs/promises").then((fs) =>
			fs.readFile(join(dest, "hello.txt"), "utf8"),
		);
		assert.equal(content, "hello from FLT-9\n");
	} finally {
		await rm(repo, { recursive: true, force: true });
		await rm(dest, { recursive: true, force: true });
	}
});

test("buildRepoSourceArchive includes only committed Git-tracked content", async () => {
	const repo = await gitRepoFixture();
	try {
		await writeFile(join(repo, ".gitignore"), "*.secret\nignored/\n");
		await writeFile(join(repo, "tracked.txt"), "safe\n");
		execFileSync("git", ["add", ".gitignore", "tracked.txt"], { cwd: repo });
		execFileSync("git", ["commit", "-q", "-m", "tracked content"], {
			cwd: repo,
		});
		await writeFile(join(repo, "untracked.secret"), "UNTRACKED_SECRET_SENTINEL\n");
		await mkdir(join(repo, "ignored"));
		await writeFile(
			join(repo, "ignored", "credential.txt"),
			"IGNORED_SECRET_SENTINEL\n",
		);

		const archive = await buildRepoSourceArchive({ cwd: repo, ref: "HEAD" });
		const entries = listTarEntries(archive.base64);

		assert.ok(entries.includes("tracked.txt"));
		assert.equal(entries.includes("untracked.secret"), false);
		assert.equal(entries.some((entry) => entry.startsWith("ignored/")), false);
		const decompressed = gunzipSync(Buffer.from(archive.base64, "base64"));
		assert.equal(
			decompressed.includes(Buffer.from("UNTRACKED_SECRET_SENTINEL")),
			false,
		);
		assert.equal(
			decompressed.includes(Buffer.from("IGNORED_SECRET_SENTINEL")),
			false,
		);
	} finally {
		await rm(repo, { recursive: true, force: true });
	}
});

test("buildRepoSourceArchive fails closed outside a Git checkout", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-fleet-archive-notgit-"));
	try {
		await writeFile(join(dir, "secret.txt"), "must not be archived\n");
		await assert.rejects(
			() => buildRepoSourceArchive({ cwd: dir }),
			/Unable to resolve Git ref HEAD/,
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("buildRepoSourceArchive fails closed when the requested ref is missing", async () => {
	const repo = await gitRepoFixture();
	try {
		await writeFile(join(repo, "untracked.secret"), "SECRET_SENTINEL\n");
		await assert.rejects(
			() =>
				buildRepoSourceArchive({
					cwd: repo,
					ref: "refs/heads/does-not-exist-locally",
				}),
			/Unable to resolve Git ref refs\/heads\/does-not-exist-locally/,
		);
	} finally {
		await rm(repo, { recursive: true, force: true });
	}
});

test("REPO_SOURCE_ARCHIVE_PATH is an absolute sandbox path under /work", () => {
	assert.match(REPO_SOURCE_ARCHIVE_PATH, /^\/work\//);
});
