import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

/**
 * V01-F1: the Flow worker image is built on the VPS from Google's apt repo, which only serves the
 * current Chrome. The deploy must refuse a build whose browser is not the one that was verified.
 */

const ROOT = resolve(import.meta.dirname, "../..");
const GATE = resolve(ROOT, "deploy/vps/flow-chrome-gate.sh");
const DEPLOY = readFileSync(resolve(ROOT, "deploy/vps/deploy.sh"), "utf8");

function bash(fn: string, ...args: string[]): number | null {
  return spawnSync("bash", ["-c", `source "${GATE}"; ${fn} "$@"`, "_", ...args]).status;
}

test("only a four-part Chrome version can be recorded", () => {
  assert.equal(bash("flow_chrome_version_is_valid", "155.0.8059.39"), 0);
  for (const bad of ["", "155", "155.0", "155.0.8059", "155.0.8059.39-1", "latest", "155.0.8059.x", " 155.0.8059.39"]) {
    assert.equal(bash("flow_chrome_version_is_valid", bad), 1, JSON.stringify(bad));
  }
});

test("the built image must report exactly the recorded version", () => {
  assert.equal(bash("flow_chrome_matches", "Google Chrome 155.0.8059.39", "155.0.8059.39"), 0);
  assert.equal(bash("flow_chrome_matches", "Google Chrome 155.0.8059.39 stable", "155.0.8059.39"), 0);
  // a newer build, a prefix of the recorded one, another browser, empty output, or an invalid record
  assert.equal(bash("flow_chrome_matches", "Google Chrome 156.0.8100.12", "155.0.8059.39"), 1);
  assert.equal(bash("flow_chrome_matches", "Google Chrome 155.0.8059.391", "155.0.8059.39"), 1);
  assert.equal(bash("flow_chrome_matches", "Google Chrome 155.0.8059.3", "155.0.8059.39"), 1);
  assert.equal(bash("flow_chrome_matches", "Chromium 155.0.8059.39", "155.0.8059.39"), 1);
  assert.equal(bash("flow_chrome_matches", "", "155.0.8059.39"), 1);
  assert.equal(bash("flow_chrome_matches", "Google Chrome 155.0.8059.39", ""), 1);
  assert.equal(bash("flow_chrome_matches", "Google Chrome 155.0.8059.39", "155.0.8059"), 1);
});

test("deploy.sh requires the record before building and checks the built image before migrations and cutover", () => {
  const required = DEPLOY.indexOf("flow_chrome_version_is_valid \"$FLOW_WORKER_CHROME_VERSION\"");
  const build = DEPLOY.indexOf('"${compose[@]}" build app ops "${flow_services[@]}"');
  const check = DEPLOY.indexOf("flow_chrome_matches \"$flow_chrome_reported\"");
  assert.ok(required > 0 && build > required, "a missing or malformed record stops the deploy before the build");
  assert.ok(check > build, "the built image is inspected after the build");
  assert.ok(check < DEPLOY.indexOf("prisma:migrate:deploy"), "before any migration");
  assert.ok(check < DEPLOY.indexOf("up -d --no-build app"), "before cutover");
  assert.match(DEPLOY, /--entrypoint \/opt\/google\/chrome\/chrome flow-worker --version/);
  assert.match(DEPLOY, /Refusing deploy: the Flow worker image reports/);
  assert.match(DEPLOY, /source "deploy\/vps\/flow-chrome-gate\.sh"/);
});

test("the record is documented in the env template, the CI summary and the runbook", () => {
  assert.match(readFileSync(resolve(ROOT, "deploy/vps/env.example"), "utf8"), /^LA_FLOW_WORKER_CHROME_VERSION=$/m);
  assert.match(readFileSync(resolve(ROOT, ".github/workflows/vps-container.yml"), "utf8"), /GITHUB_STEP_SUMMARY/);
  assert.match(readFileSync(resolve(ROOT, "docs/integrations/google-flow-virtual-try-on.md"), "utf8"), /LA_FLOW_WORKER_CHROME_VERSION/);
});
