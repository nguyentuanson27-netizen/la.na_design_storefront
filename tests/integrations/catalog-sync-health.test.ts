import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

/** Runs the real container health check, the way Docker does, against a heartbeat file. */
const SCRIPT = resolve(import.meta.dirname, "../../scripts/catalog-sync-health.ts");

function check(heartbeat: string | null, interval?: string) {
  const dir = mkdtempSync(join(tmpdir(), "catalog-sync-health-"));
  try {
    const file = join(dir, "heartbeat");
    if (heartbeat !== null) writeFileSync(file, heartbeat);
    const result = spawnSync(process.execPath, ["--experimental-strip-types", SCRIPT], {
      env: {
        NODE_ENV: "test",
        PATH: process.env.PATH,
        CATALOG_SYNC_HEARTBEAT_FILE: file,
        ...(interval === undefined ? {} : { CATALOG_SYNC_INTERVAL_SECONDS: interval }),
      },
      encoding: "utf8",
    });
    return { status: result.status, stdout: result.stdout };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a recent successful sync is healthy", () => {
  const result = check(new Date().toISOString());
  assert.equal(result.status, 0);
  assert.match(result.stdout, /catalog sync healthy/);
});

test("a loop that has never succeeded is unhealthy even though it is running", () => {
  const result = check(null);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /NEVER_SUCCEEDED/);
});

test("a heartbeat older than two intervals plus two minutes is unhealthy", () => {
  const result = check(new Date(Date.now() - 10 * 60 * 1000).toISOString(), "60");
  assert.equal(result.status, 1);
  assert.match(result.stdout, /STALE/);
});

test("an invalid interval fails the check rather than passing it", () => {
  const result = check(new Date().toISOString(), "5");
  assert.equal(result.status, 1);
});
