import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

/**
 * The Vertex overflow's credential check in `deploy/vps/deploy.sh`. The host-side check only proves
 * the file exists; this one runs inside the built app image as its own user, so a key the app cannot
 * open stops the deploy before any migration instead of failing the first overflowed try-on.
 */

const DEPLOY = readFileSync(resolve(import.meta.dirname, "../../deploy/vps/deploy.sh"), "utf8");
const CHECK_JS = /^TRY_ON_CREDENTIAL_CHECK_JS='([^']+)'$/m.exec(DEPLOY)?.[1];

function check(path: string | undefined): number | null {
  const env = { ...process.env };
  if (path === undefined) delete env.GOOGLE_APPLICATION_CREDENTIALS;
  else env.GOOGLE_APPLICATION_CREDENTIALS = path;
  return spawnSync(process.execPath, ["-e", CHECK_JS!], { env }).status;
}

test("the in-image check exists and runs in the app image, as its user, before migrations", () => {
  assert.ok(CHECK_JS, "TRY_ON_CREDENTIAL_CHECK_JS is defined");
  assert.doesNotMatch(CHECK_JS!, /readFile|read\(|console\./, "the check must never read or print the key");
  const run = DEPLOY.indexOf('run --rm --no-deps app node -e "$TRY_ON_CREDENTIAL_CHECK_JS"');
  assert.ok(run > 0, "runs in the app service, which keeps the image's USER node");
  assert.ok(run > DEPLOY.indexOf('"${compose[@]}" build app'), "after the image is built");
  assert.ok(run < DEPLOY.indexOf("prisma:migrate:deploy"), "before any migration");
  assert.ok(run < DEPLOY.indexOf('up -d --no-build app'), "before cutover");
});

test("the check accepts a readable file and refuses a missing path, a directory or no setting", () => {
  const dir = mkdtempSync(join(tmpdir(), "try-on-credential-"));
  try {
    const key = join(dir, "google.json");
    writeFileSync(key, '{"type":"service_account"}');
    mkdirSync(join(dir, "folder"));
    assert.equal(check(key), 0);
    assert.equal(check(join(dir, "missing.json")), 1);
    assert.equal(check(join(dir, "folder")), 1);
    assert.equal(check(undefined), 1);
    assert.equal(check(""), 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the check refuses a key its user cannot open (skipped as root, which can open anything)", (t) => {
  if (process.getuid?.() === 0) {
    t.skip("root bypasses file permissions");
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), "try-on-credential-"));
  try {
    const key = join(dir, "google.json");
    writeFileSync(key, "{}");
    chmodSync(key, 0o000);
    assert.equal(check(key), 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
