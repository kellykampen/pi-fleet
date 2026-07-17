import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fleetRuntimeRoot, runtimePath } from "./runtimePaths.ts";

const original = process.env.PI_FLEET_HOME;
test.afterEach(() => {
	if (original === undefined) delete process.env.PI_FLEET_HOME;
	else process.env.PI_FLEET_HOME = original;
});

test("runtime root defaults to ~/.pi-fleet and accepts an absolute override", () => {
	delete process.env.PI_FLEET_HOME;
	assert.equal(fleetRuntimeRoot(), join(homedir(), ".pi-fleet"));
	process.env.PI_FLEET_HOME = "/tmp/fleet-state";
	assert.equal(runtimePath("state", "e2b", "jobs"), "/tmp/fleet-state/state/e2b/jobs");
});

test("runtime root rejects relative, filesystem-root, and traversal overrides", () => {
	for (const unsafe of ["relative", "/", "/tmp/../etc", "/tmp//state"]) {
		process.env.PI_FLEET_HOME = unsafe;
		assert.throws(() => fleetRuntimeRoot(), /PI_FLEET_HOME/);
	}
});
