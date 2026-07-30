import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const mail = require("../bin/lib/fleet-mail.cjs");
const helper = new URL("../bin/fleet-mail", import.meta.url).pathname;

async function fixture() {
  const base = await mkdtemp(join(tmpdir(), "fleet-mail-test-"));
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

test("send/inbox/ack works between two local seats", async () => {
  const { runtime, base } = await fixture();
  try {
    let result = run(runtime, [
      "send",
      "--from",
      "worker:flt-58",
      "--to",
      "project-lead",
      "--type",
      "status",
      "--ticket",
      "FLT-58",
      "--body",
      "implementing mail v0",
      "--json",
    ]);
    assert.equal(result.status, 0, result.stderr);
    const sent = JSON.parse(result.stdout);
    assert.equal(sent.message.type, "status");
    assert.equal(sent.message.to, "project-lead");

    result = run(runtime, ["inbox", "--mailbox", "project-lead", "--unread", "--json"]);
    assert.equal(result.status, 0, result.stderr);
    const inbox = JSON.parse(result.stdout);
    assert.equal(inbox.length, 1);
    assert.equal(inbox[0].body, "implementing mail v0");

    result = run(runtime, ["show", "--mailbox", "project-lead", "--json"]);
    assert.equal(result.status, 0, result.stderr);
    const shown = JSON.parse(result.stdout);
    assert.equal(shown.id, sent.message.id);

    result = run(runtime, ["ack", "--mailbox", "project-lead", "--id", sent.message.id]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /acked/);

    result = run(runtime, ["inbox", "--mailbox", "project-lead", "--unread", "--json"]);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), []);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("status slots replace prior unacked status for same ticket", async () => {
  const { runtime, base } = await fixture();
  try {
    let result = run(runtime, [
      "send",
      "--from",
      "worker",
      "--to",
      "project-lead",
      "--type",
      "status",
      "--ticket",
      "FLT-58",
      "--body",
      "step 1",
      "--json",
    ]);
    assert.equal(result.status, 0, result.stderr);
    const first = JSON.parse(result.stdout).message.id;

    result = run(runtime, [
      "send",
      "--from",
      "worker",
      "--to",
      "project-lead",
      "--type",
      "status",
      "--ticket",
      "FLT-58",
      "--body",
      "step 2",
      "--json",
    ]);
    assert.equal(result.status, 0, result.stderr);
    const second = JSON.parse(result.stdout);
    assert.equal(second.replaced, first);
    assert.equal(second.message.body, "step 2");

    result = run(runtime, ["inbox", "--mailbox", "project-lead", "--unread", "--json"]);
    const inbox = JSON.parse(result.stdout);
    assert.equal(inbox.length, 1);
    assert.equal(inbox[0].body, "step 2");
    assert.equal(inbox[0].id, second.message.id);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("topology: worker cannot mail conductor; conductor cannot mail worker", async () => {
  const { runtime, base } = await fixture();
  try {
    let result = run(runtime, [
      "send",
      "--from",
      "worker",
      "--to",
      "conductor",
      "--type",
      "status",
      "--ticket",
      "FLT-58",
      "--body",
      "nope",
    ]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /topology/i);

    result = run(runtime, [
      "send",
      "--from",
      "conductor",
      "--to",
      "worker",
      "--type",
      "ask",
      "--body",
      "nope",
    ]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /topology/i);

    // lead → conductor rollup is allowed
    result = run(runtime, [
      "send",
      "--from",
      "project-lead",
      "--to",
      "conductor",
      "--type",
      "status",
      "--ticket",
      "FLT-58",
      "--body",
      "rollup: worker green",
    ]);
    assert.equal(result.status, 0, result.stderr);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("rate limit blocks non-status floods", async () => {
  const { runtime, base } = await fixture();
  try {
    for (let i = 0; i < 3; i += 1) {
      const result = run(
        runtime,
        [
          "send",
          "--from",
          "worker",
          "--to",
          "project-lead",
          "--type",
          "ask",
          "--body",
          `q${i}`,
        ],
        { FLEET_MAIL_RATE_LIMIT: "2", FLEET_MAIL_RATE_WINDOW_MS: "60000" },
      );
      if (i < 2) assert.equal(result.status, 0, result.stderr);
      else {
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /rate limit/i);
      }
    }
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("library exports enforce topology helpers", () => {
  assert.throws(() => mail.assertTopology("worker", "conductor"), /topology/);
  assert.throws(() => mail.assertTopology("reviewer", "conductor"), /topology/);
  assert.throws(() => mail.assertTopology("ac-verifier", "conductor"), /topology/);
  assert.doesNotThrow(() => mail.assertTopology("worker", "project-lead"));
  assert.doesNotThrow(() => mail.assertTopology("project-lead", "conductor"));
  assert.doesNotThrow(() => mail.assertTopology("conductor", "project-lead"));
  assert.equal(mail.normalizeMailbox("coordinator"), "conductor");
});

test("mail files are private mode under runtime root", async () => {
  const { runtime, base } = await fixture();
  try {
    const result = run(runtime, [
      "send",
      "--from",
      "reviewer",
      "--to",
      "project-lead",
      "--type",
      "review",
      "--body",
      "LGTM",
      "--pr",
      "https://example.test/pr/1",
      "--head",
      "abc123",
    ]);
    assert.equal(result.status, 0, result.stderr);
    const inboxFile = join(runtime, "mail", "project-lead", "inbox.json");
    const { statSync } = await import("node:fs");
    const mode = statSync(inboxFile).mode & 0o777;
    assert.equal(mode, 0o600);
    const raw = await readFile(inboxFile, "utf8");
    assert.match(raw, /LGTM/);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
