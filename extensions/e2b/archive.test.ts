import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildRepoSourceArchive, REPO_SOURCE_ARCHIVE_PATH } from "./archive.ts";

/** Extract a base64 gzip-tar payload into `dest` for round-trip assertions. */
function extractBase64Tar(base64: string, dest: string): void {
	execFileSync("bash", [
		"-c",
		`base64 -d | tar -xzf - -C ${JSON.stringify(dest)}`,
	], { input: base64 });
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
	execFileSync("git", ["config", "user.email", "fleet@pi-fleet.local"], { cwd: dir });
	execFileSync("git", ["config", "user.name", "pi-fleet"], { cwd: dir });
	await writeFile(join(dir, "hello.txt"), "hello from FLT-9\n");
	execFileSync("git", ["add", "-A"], { cwd: dir });
	execFileSync("git", ["commit", "-q", "-m", "initial"], { cwd: dir });
	return dir;
}

test("buildRepoSourceArchive packages a real git ref via git archive", async () => {
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

test("buildRepoSourceArchive falls back to tar when the directory is not a git checkout", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-fleet-archive-notgit-"));
	const dest = await mkdtemp(join(tmpdir(), "pi-fleet-archive-extract-"));
	try {
		await writeFile(join(dir, "plain.txt"), "no git here\n");

		const archive = await buildRepoSourceArchive({ cwd: dir });

		assert.equal(archive.method, "tar");
		extractBase64Tar(archive.base64, dest);
		const content = await import("node:fs/promises").then((fs) =>
			fs.readFile(join(dest, "plain.txt"), "utf8"),
		);
		assert.equal(content, "no git here\n");
	} finally {
		await rm(dir, { recursive: true, force: true });
		await rm(dest, { recursive: true, force: true });
	}
});

test("buildRepoSourceArchive tar fallback excludes .git from the payload", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-fleet-archive-notgit-dotgit-"));
	const dest = await mkdtemp(join(tmpdir(), "pi-fleet-archive-extract-"));
	try {
		await writeFile(join(dir, "plain.txt"), "tracked content\n");
		// A .git dir present but not a real repo (git archive still fails here,
		// forcing the tar fallback) — the fallback must not ship it regardless.
		const fs = await import("node:fs/promises");
		await fs.mkdir(join(dir, ".git"));
		await writeFile(join(dir, ".git", "HEAD"), "not a real repo\n");

		const archive = await buildRepoSourceArchive({ cwd: dir });

		assert.equal(archive.method, "tar");
		const entries = listTarEntries(archive.base64);
		assert.equal(entries.some((e) => e.includes(".git")), false);
	} finally {
		await rm(dir, { recursive: true, force: true });
		await rm(dest, { recursive: true, force: true });
	}
});

test("buildRepoSourceArchive falls back to tar when the requested ref does not exist locally", async () => {
	const repo = await gitRepoFixture();
	const dest = await mkdtemp(join(tmpdir(), "pi-fleet-archive-extract-"));
	try {
		const archive = await buildRepoSourceArchive({
			cwd: repo,
			ref: "refs/heads/does-not-exist-locally",
		});

		assert.equal(archive.method, "tar");
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

test("REPO_SOURCE_ARCHIVE_PATH is an absolute sandbox path under /work", () => {
	assert.match(REPO_SOURCE_ARCHIVE_PATH, /^\/work\//);
});
