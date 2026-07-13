// FLT-43 spike — scratch only. NOT production, NOT wired into any profile.
//
// Closest local/SDK proof of a Daytona "cast" mirroring the E2B extension's
// cast flow (create → upload runner → exec with per-call secrets → preview URL
// → teardown) against the REAL @daytonaio/sdk API surface. With no
// DAYTONA_API_KEY it fails at the documented, expected credential blocker.
//
// Run:
//   cd spike/daytona-flt43 && npm init -y >/dev/null && npm i @daytonaio/sdk
//   node spike-cast.mjs                # -> DaytonaAuthenticationError (no key)
//   DAYTONA_API_KEY=... node spike-cast.mjs   # -> live cast if a key is available
import { Daytona, DaytonaError } from "@daytonaio/sdk";

console.log(`DAYTONA_API_KEY present: ${Boolean(process.env.DAYTONA_API_KEY?.trim())}`);

// SDK reads DAYTONA_API_KEY / DAYTONA_API_URL (default https://app.daytona.io/api).
const daytona = new Daytona();

async function cast() {
  // 1. create   E2B: Sandbox.create(template,{timeoutMs})  Daytona: image | snapshot
  const sandbox = await daytona.create(
    {
      image: "debian:bookworm-slim",
      envVars: {},              // secrets injected per-exec below, never baked in
      autoStopInterval: 90,     // minutes of INACTIVITY -> auto-stop (E2B: absolute TTL)
      public: false,            // preview links carry a token (E2B getHost is public)
    },
    { timeout: 120, onSnapshotCreateLogs: (l) => process.stdout.write(l) },
  );
  console.log("created", sandbox.id, sandbox.state);

  // 2. upload   E2B: sandbox.files.write   Daytona: sandbox.fs.uploadFile
  await sandbox.fs.uploadFile(
    Buffer.from("#!/usr/bin/env bash\necho hi from daytona\n"),
    "/work/run-job.sh",
  );

  // 3. exec     E2B: sandbox.commands.run(cmd,{envs})  Daytona: process.executeCommand(cmd,cwd,env)
  //            (secrets passed HERE as the per-call env, not at create -> not persisted into snapshots)
  const res = await sandbox.process.executeCommand(
    "bash /work/run-job.sh",
    "/work",
    { FLEET_GITHUB_TOKEN: "***redacted***" },
    60,
  );
  console.log("exit", res.exitCode, res.result);

  // 4. preview  E2B: sandbox.getHost(port)  Daytona: getPreviewLink(port) -> {url, token}
  const preview = await sandbox.getPreviewLink(3000);
  console.log("preview", preview.url, "token?", Boolean(preview.token));

  // 5. teardown E2B: sandbox.kill()  Daytona: delete() (or stop() to keep filesystem)
  await sandbox.delete();
}

try {
  await cast();
  console.log("SPIKE: live cast SUCCEEDED");
} catch (err) {
  const kind = err instanceof DaytonaError ? err.constructor.name : (err?.constructor?.name ?? "Error");
  console.log(`SPIKE BLOCKED [${kind}]: ${err?.message ?? err}`);
}
