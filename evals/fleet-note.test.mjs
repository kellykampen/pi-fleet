import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const helper = new URL("../bin/fleet-note", import.meta.url).pathname;

async function fixture() {
  const base = await mkdtemp(join(tmpdir(), "fleet-note-test-"));
  const root = join(base, "root");
  const outside = join(base, "outside");
  await mkdir(root);
  await mkdir(outside);
  return { base, root, outside };
}

function run(root, args) {
  return spawnSync(helper, args, {
    encoding: "utf8",
    env: { ...process.env, FLEET_COORDINATION_ROOT: root },
  });
}

test("writes and appends only approved coordination documents", async () => {
  const { root } = await fixture();

  let result = run(root, ["write", "ORCHESTRATION-HANDOFF.md", "first"]);
  assert.equal(result.status, 0, result.stderr);
  result = run(root, ["append", "ORCHESTRATION-HANDOFF.md", "second"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(await readFile(join(root, "ORCHESTRATION-HANDOFF.md"), "utf8"), "first\nsecond\n");

  result = run(root, ["write", "MORNING-ESCALATIONS.md", "blocked"]);
  assert.equal(result.status, 0, result.stderr);
  result = run(root, ["write", "coordination/project/status.md", "green"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(await readFile(join(root, "coordination/project/status.md"), "utf8"), "green\n");
});

test("rejects source files, absolute paths, traversal, and malformed calls", async () => {
  const { root } = await fixture();
  for (const args of [
    ["write", "bin/foo.sh", "bad"],
    ["append", "README.md", "bad"],
    ["write", "/tmp/ORCHESTRATION-HANDOFF.md", "bad"],
    ["write", "coordination/../../bin/foo.sh", "bad"],
    ["delete", "ORCHESTRATION-HANDOFF.md", "bad"],
    ["write", "ORCHESTRATION-HANDOFF.md"],
  ]) {
    const result = run(root, args);
    assert.notEqual(result.status, 0, `${args.join(" ")} unexpectedly passed`);
  }
});

test("rejects symlinked parent and target escapes", async () => {
  const { root, outside } = await fixture();
  await symlink(outside, join(root, "coordination"));
  let result = run(root, ["write", "coordination/escape.md", "bad"]);
  assert.notEqual(result.status, 0);

  await writeFile(join(outside, "TARGET-HANDOFF.md"), "safe\n");
  await symlink(join(outside, "TARGET-HANDOFF.md"), join(root, "TARGET-HANDOFF.md"));
  result = run(root, ["append", "TARGET-HANDOFF.md", "bad"]);
  assert.notEqual(result.status, 0);
  assert.equal(await readFile(join(outside, "TARGET-HANDOFF.md"), "utf8"), "safe\n");
});

test("fails closed without a server-provided coordination root", () => {
  const result = spawnSync(helper, ["write", "ORCHESTRATION-HANDOFF.md", "bad"], {
    encoding: "utf8",
    env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== "FLEET_COORDINATION_ROOT")),
  });
  assert.notEqual(result.status, 0);
});
