import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const deployScript = fileURLToPath(
  new URL("../../deploy/vps/deploy.sh", import.meta.url),
);

test("VPS deploy quiesces the old app before capacity-resource migrations can backfill", async () => {
  const source = await readFile(deployScript, "utf8");
  const stopApp = source.indexOf('"${compose[@]}" stop app');
  const migrate = source.indexOf('"${compose[@]}" run --rm ops pnpm prisma:migrate:deploy');
  const startApp = source.indexOf('"${compose[@]}" up -d --no-build app caddy');

  assert.notEqual(stopApp, -1, "the old app must be explicitly quiesced before migration");
  assert.notEqual(migrate, -1, "the production migration command must remain present");
  assert.notEqual(startApp, -1, "the app must still be restarted after migration");
  assert.ok(
    stopApp < migrate,
    "old application writes must stop before the migration snapshots existing reservations",
  );
  assert.ok(
    migrate < startApp,
    "the new application must not serve traffic until the migration has completed",
  );
});
