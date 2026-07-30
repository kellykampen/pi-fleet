import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ws = require("../bin/lib/fleet-workspaces.cjs");
const helper = new URL("../bin/fleet-workspaces", import.meta.url).pathname;

async function fixture() {
  const base = await mkdtemp(join(tmpdir(), "fleet-ws-test-"));
  const home = join(base, "home");
  const runtime = join(home, ".pi-fleet");
  await mkdir(runtime, { recursive: true });
  return { base, home, runtime };
}

function run(runtime, args, envExtra = {}) {
  return spawnSync(helper, args, {
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: join(runtime, ".."),
      PI_FLEET_HOME: runtime,
      ...envExtra,
    },
  });
}

test("sample document has fantastic-dev and pi-fleet defaults", () => {
  const sample = ws.sampleDocument();
  assert.equal(sample.version, 1);
  assert.equal(sample.workspaces["fantastic-dev"].linear.teamKey, "FTD");
  assert.equal(sample.workspaces["fantastic-dev"].leadMailbox, "ftd-project-lead");
  assert.ok(sample.workspaces["fantastic-dev"].cwdMatchers.includes("fantastic-dev"));
  assert.equal(sample.workspaces["pi-fleet"].linear.teamKey, "FLT");
  assert.equal(sample.workspaces["pi-fleet"].leadMailbox, "pi-fleet-project-lead");
});

test("init writes defaults; second init is non-destructive", async () => {
  const { runtime, base } = await fixture();
  try {
    const first = ws.initWorkspaces({ env: { PI_FLEET_HOME: runtime, HOME: join(runtime, "..") } });
    assert.equal(first.created, true);
    const text = await readFile(first.path, "utf8");
    const doc = JSON.parse(text);
    assert.equal(doc.workspaces["pi-fleet"].leadMailbox, "pi-fleet-project-lead");

    const second = ws.initWorkspaces({ env: { PI_FLEET_HOME: runtime, HOME: join(runtime, "..") } });
    assert.equal(second.created, false);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("resolve order: slug → alias → cmux title → cwd → basename", async () => {
  const { runtime, base } = await fixture();
  try {
    const env = { PI_FLEET_HOME: runtime, HOME: join(runtime, "..") };
    ws.initWorkspaces({ env });

    assert.equal(
      ws.resolveWorkspace({ slug: "pi-fleet" }, { env }).method,
      "slug",
    );
    assert.equal(
      ws.resolveWorkspace({ alias: "flt" }, { env }).workspace.slug,
      "pi-fleet",
    );
    assert.equal(
      ws.resolveWorkspace({ cmuxTitle: "Fantastic Dev" }, { env }).workspace.leadMailbox,
      "ftd-project-lead",
    );

    const fakeCwd = join(base, "code", "fantastic-dev", "src");
    await mkdir(fakeCwd, { recursive: true });
    const byCwd = ws.resolveWorkspace({ cwd: fakeCwd }, { env });
    assert.equal(byCwd.workspace.slug, "fantastic-dev");
    assert.equal(byCwd.method, "cwdMatcher");

    const other = join(base, "code", "pi-fleet");
    await mkdir(other, { recursive: true });
    const byBase = ws.resolveWorkspace({ cwd: other }, { env });
    assert.equal(byBase.workspace.slug, "pi-fleet");
    assert.ok(["cwdMatcher", "basename"].includes(byBase.method));
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("worktree-aware basename uses repo folder", async () => {
  const { runtime, base } = await fixture();
  try {
    const env = { PI_FLEET_HOME: runtime, HOME: join(runtime, "..") };
    ws.initWorkspaces({ env });
    const wt = join(base, "code", "pi-fleet", ".worktrees", "flt-69");
    await mkdir(wt, { recursive: true });
    const resolved = ws.resolveWorkspace({ cwd: wt }, { env });
    assert.equal(resolved.workspace.slug, "pi-fleet");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("leadMailbox aligns with <workspace>-project-lead", () => {
  assert.equal(ws.defaultLeadMailbox("pi-fleet"), "pi-fleet-project-lead");
  assert.equal(ws.defaultLeadMailbox("fantastic-dev"), "ftd-project-lead");
  assert.equal(ws.defaultLeadMailbox("agent-skills"), "agent-skills-project-lead");
});

test("allowedRepoRoots must be absolute; env export uses them", async () => {
  const { runtime, base } = await fixture();
  try {
    const env = { PI_FLEET_HOME: runtime, HOME: join(runtime, "..") };
    const rootA = join(base, "repos", "pi-fleet");
    await mkdir(rootA, { recursive: true });
    await writeFile(
      join(runtime, "workspaces.json"),
      JSON.stringify(
        {
          version: 1,
          workspaces: {
            "pi-fleet": {
              leadMailbox: "pi-fleet-project-lead",
              linear: { teamKey: "FLT" },
              allowedRepoRoots: [rootA],
              cwdMatchers: ["pi-fleet"],
            },
          },
        },
        null,
        2,
      ),
    );
    const resolved = ws.resolveWorkspace({ slug: "pi-fleet" }, { env });
    const envMap = ws.envForWorkspace(resolved.workspace, rootA, {
      workspacesPath: join(runtime, "workspaces.json"),
    });
    assert.equal(envMap.FLEET_LEAD_MAILBOX, "pi-fleet-project-lead");
    assert.equal(envMap.FLEET_ALLOWED_REPO_ROOTS, rootA);
    assert.equal(envMap.FLEET_LINEAR_TEAM_KEY, "FLT");

    assert.throws(
      () =>
        ws.normalizeWorkspaceEntry("x", {
          allowedRepoRoots: ["relative/path"],
        }),
      /absolute/,
    );
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("CLI path/list/resolve/sample work", async () => {
  const { runtime, base } = await fixture();
  try {
    let result = run(runtime, ["path"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout.trim(), /workspaces\.json$/);

    result = run(runtime, ["init"]);
    assert.equal(result.status, 0, result.stderr);

    result = run(runtime, ["list", "--json"]);
    assert.equal(result.status, 0, result.stderr);
    const listed = JSON.parse(result.stdout);
    assert.ok(listed.workspaces.some((w) => w.slug === "pi-fleet"));

    result = run(runtime, ["resolve", "--slug", "fantastic-dev", "--json"]);
    assert.equal(result.status, 0, result.stderr);
    const resolved = JSON.parse(result.stdout);
    assert.equal(resolved.workspace.leadMailbox, "ftd-project-lead");

    result = run(runtime, ["sample"]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).version, 1);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("invalid JSON fails closed", async () => {
  const { runtime, base } = await fixture();
  try {
    await writeFile(join(runtime, "workspaces.json"), "{not-json");
    assert.throws(
      () => ws.loadWorkspaces({ env: { PI_FLEET_HOME: runtime, HOME: join(runtime, "..") } }),
      /invalid JSON|bad_json/,
    );
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("assertPathAllowed enforces roots", () => {
  const roots = ["/Users/x/code/pi-fleet"];
  assert.equal(ws.assertPathAllowed("/Users/x/code/pi-fleet/src", roots).allowed, true);
  assert.equal(ws.assertPathAllowed("/Users/x/code/other", roots).allowed, false);
});
