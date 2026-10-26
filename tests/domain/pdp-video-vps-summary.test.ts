import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

const REPO = resolve(import.meta.dirname, "../..");
function run({ target = "production", failLogs = false, omitEnv = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "pdp-video-vps-"));
  try {
    const repo = join(root, "repo");
    const bin = join(root, "bin");
    const scratch = join(root, "scratch");
    mkdirSync(bin); mkdirSync(scratch);
    for (const relative of ["deploy/vps/pdp-video-telemetry.sh", "deploy/vps/project-identity.sh", "scripts/pdp-video-playback-summary.ts", "src/operations/pdp-video-playback-summary.ts", "src/commerce/pdp-video-playback.ts"]) {
      mkdirSync(dirname(join(repo, relative)), { recursive: true });
      copyFileSync(join(REPO, relative), join(repo, relative));
    }
    writeFileSync(join(repo, "package.json"), '{"type":"module"}');
    writeFileSync(join(repo, "project.config.json"), JSON.stringify({ projectSlug: "fixture-project", databaseName: "fixture_db", composeProjectName: "fixture-compose", productionDomain: "production.example.test", temporaryDomain: "temporary.example.test" }));
    if (!omitEnv) writeFileSync(join(repo, "deploy/vps/.env.production"), `DEPLOY_TARGET=${target}\nRELEASE_SHA=fixture-release\nPOSTGRES_PASSWORD=private-fixture-value\nUNTRUSTED=$(touch ${join(root, "must-not-execute")})\n`);
    const calls = join(root, "calls.json");
    writeFileSync(join(bin, "docker"), `#!/usr/bin/env node
const fs=require('node:fs');const cp=require('node:child_process');const args=process.argv.slice(2);
fs.appendFileSync(process.env.CALLS,JSON.stringify({args,identity:{target:process.env.DEPLOY_TARGET,project:process.env.PROJECT_SLUG,database:process.env.POSTGRES_DB,compose:process.env.COMPOSE_PROJECT_NAME,origin:process.env.APP_DOMAIN,auth:process.env.BETTER_AUTH_URL},secretExported:process.env.POSTGRES_PASSWORD!==undefined})+'\\n');
if(args.includes('logs')){
  if(process.env.FAIL_LOGS==='1'){process.stdout.write('partial invalid logs');process.exit(42);}
  process.stdout.write('{"name":"pdp_video.playback","attempts":1,"failures":0}\\n{"name":"pdp_video.playback","attempts":0,"failures":1,"reason":"timeout"}\\n');
}else if(args.includes('run')){
  const result=cp.spawnSync(process.execPath,args.slice(args.indexOf('node')+1),{stdio:'inherit'});process.exit(result.status??1);
}else process.exit(99);
`);
    chmodSync(join(bin, "docker"), 0o755);
    const result = spawnSync("bash", [join(repo, "deploy/vps/pdp-video-telemetry.sh"), "2h"], {
      cwd: root, // A fresh shell outside the repository, with no deployment variables inherited.
      env: { NODE_ENV: "test", PATH: `${bin}:${process.env.PATH}`, TMPDIR: scratch, CALLS: calls, FAIL_LOGS: failLogs ? "1" : "0" },
      encoding: "utf8",
    });
    return { ...result, calls: existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : null, scratchFiles: readdirSync(scratch), executedEnv: existsSync(join(root, "must-not-execute")) };
  } finally { rmSync(root, { recursive: true, force: true }); }
}
for (const target of ["production", "temporary"]) {
  test(`VPS telemetry command loads identity and --env-file from a clean ${target} shell`, () => {
    const result = run({ target });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.calls);
    assert.deepEqual(result.calls[0].args, ["compose", "--env-file", "deploy/vps/.env.production", "-f", "deploy/vps/compose.yml", "logs", "--no-color", "--no-log-prefix", "--since=2h", "app"]);
    assert.deepEqual(result.calls[0].identity, { target, project: "fixture-project", database: "fixture_db", compose: "fixture-compose", origin: `${target}.example.test`, auth: `https://${target}.example.test` });
    assert.equal(result.calls[0].secretExported, false);
    assert.deepEqual(result.calls[1].args, ["compose", "--env-file", "deploy/vps/.env.production", "-f", "deploy/vps/compose.yml", "run", "--rm", "-T", "--no-deps", "--pull=never", "ops", "node", "--experimental-strip-types", "scripts/pdp-video-playback-summary.ts"]);
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.attempts, 1); assert.equal(summary.errors.timeout, 1);
    assert.equal(result.stdout.includes("private-fixture-value"), false);
    assert.equal(result.executedEnv, false);
    assert.deepEqual(result.scratchFiles, []);
  });
}
test("failed log collection, missing env and invalid target cannot produce a telemetry report", () => {
  for (const options of [{ failLogs: true }, { omitEnv: true }, { target: "invalid" }]) {
    const result = run(options);
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, "");
    assert.equal(result.executedEnv, false);
    assert.deepEqual(result.scratchFiles, []);
  }
});
