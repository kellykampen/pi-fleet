import assert from "node:assert/strict";
import test from "node:test";
import { evaluateLinearSeatCommand } from "../bin/lib/linear-seat-command-policy.mjs";

const allow = (command) =>
  assert.equal(evaluateLinearSeatCommand(command).allowed, true, command);
const deny = (command) =>
  assert.equal(evaluateLinearSeatCommand(command).allowed, false, command);

test("allows linear-cli and spike interview workflow commands", () => {
  for (const command of [
    "linear-cli issues create Title -t TEAM -d body",
    'linear-cli issues create "Title" -t TEAM -d "$(cat /tmp/body.md)"',
    "linear-cli issues update ABC-1 --description body",
    "linear-cli projects create Epic -t TEAM",
    "linear-cli comments create --body note ABC-1",
    "pi-fleet-spike-interview run --issue SPIKE-1 --questions /tmp/q.json",
    "pi-fleet-spike-interview record --issue SPIKE-1 --questions /tmp/q.json --result /tmp/r.json",
    "/usr/local/bin/linear-cli issue get ABC-1",
  ]) allow(command);
});

test("allows staging and read utilities used by linear seats", () => {
  for (const command of [
    "cat /tmp/body.md",
    "ls -la",
    "rg -n pattern .",
    "mkdir -p /tmp/plan",
    "rm -rf /tmp/plan",
    "mktemp -t body",
    "jq -r .id /tmp/out.json",
  ]) allow(command);
});

test("denies implementation, package managers, git writes, and unsafe chaining", () => {
  for (const command of [
    "pnpm test",
    "npm ci",
    "node build.js",
    "python3 script.py",
    "git commit -am x",
    "git push origin main",
    "bash script.sh",
    "rm -rf /",
    "rm -rf /Users/me/code",
    "linear-cli issues create T -t X; pnpm test",
    "pnpm test && linear-cli issues create T -t X",
  ]) deny(command);
});
