import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, unlink } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	assertRuntimePathNoSymlinks,
	fleetRuntimeRoot,
	runtimePath,
} from "./runtimePaths.ts";

const original = process.env.PI_FLEET_HOME;
test.afterEach(() => {
	if (original === undefined) delete process.env.PI_FLEET_HOME;
	else process.env.PI_FLEET_HOME = original;
});

test("runtime root defaults to ~/.pi-fleet and accepts a canonical absolute override", () => {
	delete process.env.PI_FLEET_HOME;
	assert.equal(fleetRuntimeRoot(), join(homedir(), ".pi-fleet"));
	process.env.PI_FLEET_HOME = "/tmp/fleet-state/";
	assert.equal(
		runtimePath("state", "e2b", "jobs"),
		`${fleetRuntimeRoot()}/state/e2b/jobs`,
	);
	assert.equal(fleetRuntimeRoot().endsWith("/"), false);
});

test("runtime root rejects relative, filesystem-root, and traversal overrides", () => {
	for (const unsafe of ["relative", "/", "/tmp/../etc", "/tmp//state"]) {
		process.env.PI_FLEET_HOME = unsafe;
		assert.throws(() => fleetRuntimeRoot(), /PI_FLEET_HOME/);
	}
});

test("symlinked ancestors are canonicalized once and child symlinks are rejected", async () => {
	const temp = await mkdtemp(join(tmpdir(), "pi-fleet-paths-"));
	try {
		const physical = join(temp, "physical");
		await mkdir(join(physical, "fleet", "state"), { recursive: true });
		await symlink(physical, join(temp, "ancestor"));
		process.env.PI_FLEET_HOME = join(temp, "ancestor", "fleet");
		const pinnedRoot = await realpath(join(physical, "fleet"));
		assert.equal(fleetRuntimeRoot(), pinnedRoot);
		const retarget = join(temp, "retarget");
		await mkdir(join(retarget, "fleet"), { recursive: true });
		await unlink(join(temp, "ancestor"));
		await symlink(retarget, join(temp, "ancestor"));
		assert.equal(fleetRuntimeRoot(), pinnedRoot);
		await assertRuntimePathNoSymlinks(runtimePath("state"));
		await symlink(join(physical, "fleet"), join(temp, "root-link"));
		process.env.PI_FLEET_HOME = join(temp, "root-link");
		assert.equal(fleetRuntimeRoot(), await realpath(join(physical, "fleet")));
		process.env.PI_FLEET_HOME = join(temp, "ancestor", "fleet");
		await symlink(temp, join(physical, "fleet", "state", "nested"));
		await assert.rejects(
			() => assertRuntimePathNoSymlinks(runtimePath("state", "nested", "file")),
			/symlink/i,
		);
	} finally {
		await rm(temp, { recursive: true, force: true });
	}
});
