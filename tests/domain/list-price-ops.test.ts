import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
const REPO = resolve(import.meta.dirname, "../..");
function run(args: string[], target = "production", fail = false) {
  const root = mkdtempSync(join(tmpdir(), "list-price-ops-")),
    repo = join(root, "repo"),
    bin = join(root, "bin"),
    calls = join(root, "calls");
  try {
    mkdirSync(bin);
    for (const file of [
      "deploy/vps/list-price-ops.sh",
      "deploy/vps/project-identity.sh",
    ]) {
      mkdirSync(dirname(join(repo, file)), { recursive: true });
      copyFileSync(join(REPO, file), join(repo, file));
    }
    writeFileSync(
      join(repo, "project.config.json"),
      JSON.stringify({
        projectSlug: "fixture-project",
        databaseName: "fixture_db",
        composeProjectName: "fixture-compose",
        productionDomain: "production.example.test",
        temporaryDomain: "temporary.example.test",
      }),
    );
    writeFileSync(
      join(repo, "deploy/vps/.env.production"),
      `DEPLOY_TARGET=${target}\nPOSTGRES_PASSWORD=private-value\nUNTRUSTED=$(touch ${join(root, "must-not-execute")})\n`,
    );
    writeFileSync(
      join(bin, "docker"),
      `#!/usr/bin/env node\nconst fs=require('node:fs');fs.appendFileSync(process.env.CALLS,JSON.stringify({args:process.argv.slice(2),domain:process.env.APP_DOMAIN,secret:process.env.POSTGRES_PASSWORD??null})+'\\n');process.exit(process.env.FAIL==='1'?42:0);`,
    );
    chmodSync(join(bin, "docker"), 0o755);
    const result = spawnSync(
      "bash",
      [join(repo, "deploy/vps/list-price-ops.sh"), ...args],
      {
        cwd: root,
        env: {
          NODE_ENV: "test",
          PATH: `${bin}:${process.env.PATH}`,
          CALLS: calls,
          FAIL: fail ? "1" : "0",
        },
        encoding: "utf8",
      },
    );
    return {
      ...result,
      calls: existsSync(calls)
        ? readFileSync(calls, "utf8")
            .trim()
            .split("\n")
            .map((row) => JSON.parse(row))
        : [],
      executed: existsSync(join(root, "must-not-execute")),
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
for (const target of ["production", "temporary"])
  test(`operator commands load Compose identity/env from a clean ${target} shell`, () => {
    const audit = run(["audit"], target);
    assert.equal(audit.status, 0, audit.stderr);
    assert.equal(audit.executed, false);
    assert.deepEqual(audit.calls[0].args, [
      "compose",
      "--env-file",
      "deploy/vps/.env.production",
      "-f",
      "deploy/vps/compose.yml",
      "run",
      "--rm",
      "-T",
      "--no-deps",
      "--pull=never",
      "ops",
      "node",
      "--experimental-strip-types",
      "scripts/list-price-audit.ts",
    ]);
    assert.equal(audit.calls[0].domain, `${target}.example.test`);
    assert.equal(audit.calls[0].secret, null);
    const config = run(["config", "app"], target);
    assert.equal(config.status, 0);
    assert.ok(config.calls[0].args.includes("exec"));
    assert.ok(config.calls[1].args.includes("images"));
    assert.equal(
      config.calls.some((call: { args: string[] }) =>
        call.args.includes("run"),
      ),
      false,
    );
  });
test("operator refusals propagate without sourcing secrets or starting unrelated services", () => {
  for (const args of [
    ["unknown"],
    ["config", "postgres"],
    ["freeze", "bad;id"],
    ["release", "valid", "unexpected"],
  ]) {
    const result = run(args);
    assert.notEqual(result.status, 0);
    assert.equal(result.calls.length, 0);
    assert.equal(result.executed, false);
  }
  assert.equal(run(["audit"], "production", true).status, 42);
});
