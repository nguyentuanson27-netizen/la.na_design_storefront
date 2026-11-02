import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

/**
 * Runs the real `deploy/vps/deploy.sh` and `rollback.sh` against a stand-in `docker` that records
 * every call, so these tests pin the order commands actually execute in, not how the scripts happen
 * to be spelled.
 */

const REPO_ROOT = resolve(import.meta.dirname, "../..");

const FAKE_DOCKER = `#!/usr/bin/env bash
set -euo pipefail
echo "$*" >> "$CALL_LOG"
if [[ "\${1:-}" == "image" && "\${2:-}" == "inspect" ]]; then
  [[ " \${FAKE_IMAGES:-} " == *" \${3:-} "* ]] && exit 0 || exit 1
fi
if [[ "\${1:-}" == "inspect" ]]; then
  container="\${*: -1}"
  if [[ "$container" == "catalog-sync-container" ]]; then echo "\${FAKE_SYNC_HEALTH:-healthy}"; else echo healthy; fi
  exit 0
fi
args=" $* "
case "$args" in
  *" ps -q postgres "*) echo postgres-container ;;
  *" ps -q "*) service="\${args##* ps -q }"; service="\${service%% *}"
    if [[ -f "$FAKE_STATE/$service-running" ]]; then echo "$service-container"; fi ;;
  *" stop "*) service="\${args##* stop }"; rm -f "$FAKE_STATE/\${service%% *}-running" ;;
  *" start "*) service="\${args##* start }"; touch "$FAKE_STATE/\${service%% *}-running" ;;
  *" up -d --no-build "*) for service in \${args##* --no-build }; do touch "$FAKE_STATE/$service-running"; done ;;
  *" pnpm prisma:migrate:deploy "*) exit "\${FAKE_MIGRATE_EXIT:-0}" ;;
  *" pnpm capacity:handoff:reconcile "*) exit "\${FAKE_RECONCILE_EXIT:-0}" ;;
  *" pnpm pancake:secondary:teardown "*)
    if [[ "\${FAKE_TEARDOWN_EXIT:-0}" == "0" && "\${FAKE_TEARDOWN_KEEPS_ROWS:-0}" != "1" ]]; then echo 0 > "$FAKE_STATE/secondary-rows"; fi
    exit "\${FAKE_TEARDOWN_EXIT:-0}" ;;
  *" exec -T postgres sh -ec psql "*)
    if [[ "\${FAKE_PSQL_EXIT:-0}" != "0" ]]; then exit "$FAKE_PSQL_EXIT"; fi
    cat "$FAKE_STATE/secondary-rows" ;;
  *" exec -T postgres "*) echo fake-dump ;;
  *" --entrypoint /opt/google/chrome/chrome "*) echo "\${FAKE_CHROME:-}" ;;
esac
`;

type Run = { status: number | null; calls: string[]; stderr: string; stdout: string };

type ScriptRun = {
  running: readonly ("app" | "catalog-sync")[];
  migrateExit?: number;
  reconcileExit?: number;
  syncHealth?: "healthy" | "unhealthy";
  images?: readonly string[];
  /** Extra lines for deploy/vps/.env.production, e.g. to switch the Flow worker on. */
  envLines?: readonly string[];
  /** What the fake Flow worker image's `chrome --version` prints. */
  chrome?: string;
  /** Secondary-shop WarehouseStock rows the mirror holds when the rollback starts (default 0). */
  secondaryRows?: number;
  /** Exit code of the secondary-stock teardown the rollback runs (default 0). */
  teardownExit?: number;
  /** The teardown exits 0 yet leaves its rows behind (default false). */
  teardownKeepsRows?: boolean;
  /** Exit code of the rollback's own database probe (default 0). */
  psqlExit?: number;
  /** Whether the release being left has an ops image (default true). */
  currentOpsImage?: boolean;
};

function runDeploy(options: ScriptRun): Run {
  return runScript("deploy.sh", [], options);
}

const PREVIOUS_SHA = "a".repeat(40);
const PROJECT_SLUG = JSON.parse(readFileSync(join(REPO_ROOT, "project.config.json"), "utf8")).projectSlug as string;

function runRollback(options: ScriptRun): Run {
  return runScript("rollback.sh", [PREVIOUS_SHA], options);
}

function runScript(
  script: "deploy.sh" | "rollback.sh",
  args: readonly string[],
  {
    running,
    migrateExit = 0,
    reconcileExit = 0,
    syncHealth = "healthy",
    images = [],
    envLines = [],
    chrome = "",
    secondaryRows = 0,
    teardownExit = 0,
    teardownKeepsRows = false,
    psqlExit = 0,
    currentOpsImage = true,
  }: ScriptRun,
): Run {
  const root = mkdtempSync(join(tmpdir(), "deploy-sequence-"));
  try {
    const repo = join(root, "repo");
    const bin = join(root, "bin");
    const state = join(root, "state");
    mkdirSync(join(repo, "deploy/vps"), { recursive: true });
    mkdirSync(bin);
    mkdirSync(state);
    for (const file of [
      "deploy/vps/deploy.sh",
      "deploy/vps/rollback.sh",
      "deploy/vps/project-identity.sh",
      "deploy/vps/flow-chrome-gate.sh",
      "project.config.json",
    ]) {
      copyFileSync(join(REPO_ROOT, file), join(repo, file));
    }
    writeFileSync(join(repo, ".gitignore"), "deploy/vps/.env.production\n");
    const git = (...args: string[]) =>
      execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.test", ...args], { cwd: repo })
        .toString()
        .trim();
    git("init", "-q");
    git("add", "-A");
    git("commit", "-q", "-m", "release");
    writeFileSync(
      join(repo, "deploy/vps/.env.production"),
      `DEPLOY_TARGET=production\nRELEASE_SHA=${git("rev-parse", "HEAD")}\n${envLines.map((line) => `${line}\n`).join("")}`,
    );

    const headSha = git("rev-parse", "HEAD");
    const knownImages = [...images, ...(currentOpsImage ? [`${PROJECT_SLUG}-ops:${headSha}`] : [])];
    writeFileSync(join(bin, "docker"), FAKE_DOCKER);
    chmodSync(join(bin, "docker"), 0o755);
    for (const service of running) writeFileSync(join(state, `${service}-running`), "");
    writeFileSync(join(state, "secondary-rows"), `${secondaryRows}\n`);
    const callLog = join(root, "calls.log");
    writeFileSync(callLog, "");

    const result = spawnSync("bash", [`deploy/vps/${script}`, ...args], {
      cwd: repo,
      env: {
        NODE_ENV: "test",
        PATH: `${bin}:${process.env.PATH}`,
        HOME: root,
        CALL_LOG: callLog,
        FAKE_STATE: state,
        FAKE_MIGRATE_EXIT: String(migrateExit),
        FAKE_RECONCILE_EXIT: String(reconcileExit),
        FAKE_SYNC_HEALTH: syncHealth,
        FAKE_IMAGES: knownImages.join(" "),
        FAKE_TEARDOWN_EXIT: String(teardownExit),
        FAKE_TEARDOWN_KEEPS_ROWS: teardownKeepsRows ? "1" : "0",
        FAKE_PSQL_EXIT: String(psqlExit),
        FAKE_CHROME: chrome,
        BACKUP_DIR: join(root, "backups"),
      },
      encoding: "utf8",
    });
    const calls = readFileSync(callLog, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => line.replace(/^compose --env-file \S+ -f \S+ /, ""));
    return { status: result.status, calls, stderr: result.stderr, stdout: result.stdout };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function position(calls: string[], command: string): number {
  return calls.findIndex((call) => call === command);
}

const STOP_APP = "stop app";
const STOP_SYNC = "stop catalog-sync";
const MIGRATE = "run --rm ops pnpm prisma:migrate:deploy";
const START_NEW = "up -d --no-build app caddy catalog-sync";
const RECONCILE = "run --rm ops pnpm capacity:handoff:reconcile";
const RESTART_APP = "start app";
const RESTART_SYNC = "start catalog-sync";
const RELEASE_CHECK = "run --rm ops pnpm release:check";
const BACKUP = "exec -T postgres sh -ec pg_dump -U \"$POSTGRES_USER\" -d \"$POSTGRES_DB\" --format=custom";

test("a release quiesces every serving writer, migrates, then starts the new release", () => {
  const run = runDeploy({ running: ["app", "catalog-sync"], migrateExit: 0 });
  assert.equal(run.status, 0, run.stderr);
  const [check, backup, stopApp, stopSync, migrate, start] = [
    RELEASE_CHECK,
    BACKUP,
    STOP_APP,
    STOP_SYNC,
    MIGRATE,
    START_NEW,
  ].map((command) => position(run.calls, command));
  assert.ok(check >= 0 && backup > check, "release preflight and backup still precede everything that changes data");
  assert.ok(stopApp > backup && stopSync > backup, "writers stop after the backup");
  assert.ok(migrate > stopApp && migrate > stopSync, "the migration runs only once no old writer is running");
  assert.ok(start > migrate, "the new release, catalog sync included, starts only after the migration succeeded");
  assert.equal(position(run.calls, RESTART_APP), -1);
  assert.equal(position(run.calls, RESTART_SYNC), -1);
});

test("a failed migration restarts exactly the stopped pre-release writers and never starts the new ones", () => {
  const run = runDeploy({ running: ["app", "catalog-sync"], migrateExit: 3 });
  assert.notEqual(run.status, 0);
  const migrate = position(run.calls, MIGRATE);
  assert.ok(position(run.calls, STOP_APP) >= 0 && position(run.calls, STOP_SYNC) >= 0);
  assert.ok(position(run.calls, RESTART_APP) > migrate);
  assert.ok(position(run.calls, RESTART_SYNC) > migrate);
  // `start` resumes the stopped container; `up` would recreate it from the new image.
  assert.equal(position(run.calls, START_NEW), -1);
  assert.equal(run.calls.filter((call) => call.startsWith("up -d") && call.includes(" app")).length, 0);
});

test("only a writer that was running is stopped and, on failure, restarted", () => {
  const run = runDeploy({ running: ["app"], migrateExit: 1 });
  assert.notEqual(run.status, 0);
  assert.ok(position(run.calls, STOP_APP) >= 0);
  assert.equal(position(run.calls, STOP_SYNC), -1);
  assert.ok(position(run.calls, RESTART_APP) > position(run.calls, MIGRATE));
  assert.equal(position(run.calls, RESTART_SYNC), -1);
});

test("with nothing running before the release, a failed migration invents no restart target", () => {
  const run = runDeploy({ running: [], migrateExit: 1 });
  assert.notEqual(run.status, 0);
  for (const command of [STOP_APP, STOP_SYNC, RESTART_APP, RESTART_SYNC, START_NEW]) {
    assert.equal(position(run.calls, command), -1, command);
  }
  assert.ok(position(run.calls, MIGRATE) >= 0);
});

test("a first release with nothing serving migrates and starts the new release", () => {
  const run = runDeploy({ running: [], migrateExit: 0 });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(position(run.calls, STOP_APP), -1);
  assert.ok(position(run.calls, START_NEW) > position(run.calls, MIGRATE));
});

test("a release whose catalog sync never succeeds is reported as a failed deploy", () => {
  const run = runDeploy({ running: ["app", "catalog-sync"], syncHealth: "unhealthy" });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /catalog sync has not succeeded/);
  // The app itself did come up: the failure is about the sync, and says so.
  assert.ok(position(run.calls, START_NEW) >= 0);
  assert.ok(run.calls.some((call) => call === "logs --tail=200 catalog-sync"));
});

const ROLLBACK_APP = "up -d --no-build app caddy";
const ROLLBACK_SYNC = "up -d --no-build catalog-sync";

test("rollback quiesces the current catalog sync before the previous app starts, then starts that release's sync", () => {
  const run = runRollback({
    running: ["app", "catalog-sync"],
    images: [`${PROJECT_SLUG}:${PREVIOUS_SHA}`, `${PROJECT_SLUG}-ops:${PREVIOUS_SHA}`],
  });
  assert.equal(run.status, 0, run.stderr);
  const stop = position(run.calls, STOP_SYNC);
  const app = position(run.calls, ROLLBACK_APP);
  const sync = position(run.calls, ROLLBACK_SYNC);
  assert.ok(stop >= 0 && app > stop, "no window where the older app runs beside the newer sync");
  assert.ok(sync > app, "the previous release's own sync starts after its app");
});

const TEARDOWN = "run --rm ops pnpm pancake:secondary:teardown";

const PROBE = "exec -T postgres sh -ec psql -U \"$POSTGRES_USER\" -d \"$POSTGRES_DB\" -v ON_ERROR_STOP=1 -tA";
const PREVIOUS_IMAGES = [`${PROJECT_SLUG}:${PREVIOUS_SHA}`, `${PROJECT_SLUG}-ops:${PREVIOUS_SHA}`];

function assertRefused(run: Run, message: RegExp) {
  assert.notEqual(run.status, 0);
  assert.equal(position(run.calls, ROLLBACK_APP), -1, "the previous release never starts over rows it would miscount");
  assert.ok(run.calls.some((call) => call === "start catalog-sync"), "the writer that was stopped is restored");
  assert.match(run.stderr, message);
}

test("rollback removes the secondary shop's stock after the writers are quiet and before the previous app serves", () => {
  const run = runRollback({ running: ["app", "catalog-sync"], images: PREVIOUS_IMAGES, secondaryRows: 3 });
  assert.equal(run.status, 0, run.stderr);
  const stop = position(run.calls, STOP_SYNC);
  const teardown = position(run.calls, TEARDOWN);
  const app = position(run.calls, ROLLBACK_APP);
  assert.ok(stop >= 0 && teardown > stop, "the current sync is stopped first, so nothing writes while the rows go");
  assert.ok(app > teardown, "the previous release takes traffic only after the rows are gone");
  const probes = run.calls.flatMap((call, index) => (call === PROBE ? [index] : []));
  assert.equal(probes.length, 2, "the database is read before the teardown and again after it");
  assert.ok(probes[0]! < teardown && probes[1]! > teardown && probes[1]! < app);
});

test("rollback leaves the teardown alone when the mirror holds no secondary stock", () => {
  const run = runRollback({ running: ["app", "catalog-sync"], images: PREVIOUS_IMAGES, secondaryRows: 0 });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(position(run.calls, TEARDOWN), -1);
  assert.ok(position(run.calls, ROLLBACK_APP) > position(run.calls, PROBE));
});

test("rollback from a release with no ops image still passes when the database proves there is nothing to remove", () => {
  const run = runRollback({
    running: ["app", "catalog-sync"],
    images: [`${PROJECT_SLUG}:${PREVIOUS_SHA}`],
    currentOpsImage: false,
    secondaryRows: 0,
  });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(position(run.calls, TEARDOWN), -1);
});

test("a failed teardown stops the rollback before the previous app starts and puts the current sync back", () => {
  const run = runRollback({ running: ["app", "catalog-sync"], images: PREVIOUS_IMAGES, secondaryRows: 3, teardownExit: 1 });
  assertRefused(run, /Could not remove the secondary shop's stock.*was NOT started/);
});

test("rows left behind by a teardown that exits 0 still stop the rollback", () => {
  const run = runRollback({
    running: ["app", "catalog-sync"],
    images: PREVIOUS_IMAGES,
    secondaryRows: 3,
    teardownKeepsRows: true,
  });
  assertRefused(run, /still holds secondary-shop stock/);
});

test("secondary rows with no ops image of the release being left to remove them stop the rollback", () => {
  const run = runRollback({
    running: ["app", "catalog-sync"],
    images: [`${PROJECT_SLUG}:${PREVIOUS_SHA}`],
    currentOpsImage: false,
    secondaryRows: 3,
  });
  assertRefused(run, /ops image of the release being left is not available/);
  assert.equal(position(run.calls, TEARDOWN), -1);
});

test("a database probe that fails stops the rollback instead of assuming there is nothing to remove", () => {
  const run = runRollback({ running: ["app", "catalog-sync"], images: PREVIOUS_IMAGES, secondaryRows: 3, psqlExit: 2 });
  assertRefused(run, /Could not read whether the mirror holds secondary-shop stock/);
  assert.equal(position(run.calls, TEARDOWN), -1);
});

test("rollback to a release without a catalog-sync image leaves sync stopped and warns", () => {
  const run = runRollback({
    running: ["app", "catalog-sync"],
    images: [`${PROJECT_SLUG}:${PREVIOUS_SHA}`],
  });
  assert.equal(run.status, 0, run.stderr);
  assert.ok(position(run.calls, STOP_SYNC) >= 0);
  assert.ok(position(run.calls, ROLLBACK_APP) > position(run.calls, STOP_SYNC));
  assert.equal(position(run.calls, ROLLBACK_SYNC), -1);
  assert.match(run.stderr, /WARNING: .* has no catalog-sync image/);
});

test("rollback refuses before touching any writer when the previous app image is missing", () => {
  const run = runRollback({ running: ["app", "catalog-sync"], images: [] });
  assert.notEqual(run.status, 0);
  assert.equal(position(run.calls, STOP_SYNC), -1);
  assert.equal(position(run.calls, ROLLBACK_APP), -1);
});

test("a release records pending capacity handoffs after migrating and before any new writer serves", () => {
  // deploy -> rollback to a release that retires holds without recording them -> roll forward: the
  // migration's backfill does not run again, so this step is what keeps those retired holds from
  // counting again while the new release waits for its first catalog sync.
  const packageJson = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };
  assert.match(packageJson.scripts["capacity:handoff:reconcile"] ?? "", /capacity-handoff-reconcile\.ts/);

  const run = runDeploy({ running: ["app", "catalog-sync"] });
  assert.equal(run.status, 0, run.stderr);
  const migrate = position(run.calls, MIGRATE);
  const reconcile = position(run.calls, RECONCILE);
  const start = position(run.calls, START_NEW);
  assert.ok(reconcile > migrate, "reconciliation reads the migrated schema");
  assert.ok(position(run.calls, STOP_APP) < reconcile && position(run.calls, STOP_SYNC) < reconcile);
  assert.ok(start > reconcile, "no new writer or Caddy starts before the handoffs are recorded");
});

test("a failed handoff reconciliation restores exactly the pre-release writers and starts nothing new", () => {
  const run = runDeploy({ running: ["app", "catalog-sync"], reconcileExit: 1 });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /Capacity handoff reconciliation failed/);
  const reconcile = position(run.calls, RECONCILE);
  assert.ok(position(run.calls, RESTART_APP) > reconcile);
  assert.ok(position(run.calls, RESTART_SYNC) > reconcile);
  assert.equal(position(run.calls, START_NEW), -1);
});

test("a failed migration never reaches the handoff reconciliation", () => {
  const run = runDeploy({ running: ["app"], migrateExit: 1 });
  assert.notEqual(run.status, 0);
  assert.equal(position(run.calls, RECONCILE), -1);
});

const FLOW_ON = [
  "LA_TRY_ON_ENABLED=true",
  "LA_TRY_ON_PROVIDER=flow",
  "LA_TRY_ON_FLOW_URL=http://flow-worker:8787",
];
const BUILD_ALL = "--profile flow-try-on build app ops flow-worker";

test("V01-F1: a Flow deploy without a recorded Chrome version stops before building anything", () => {
  for (const envLines of [FLOW_ON, [...FLOW_ON, "LA_FLOW_WORKER_CHROME_VERSION=155.0.8059.39-1"], [...FLOW_ON, "LA_FLOW_WORKER_CHROME_VERSION=155"]]) {
    const run = runDeploy({ running: [], envLines, chrome: "Google Chrome 155.0.8059.39" });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /requires LA_FLOW_WORKER_CHROME_VERSION/);
    assert.equal(run.calls.some((call) => call.includes("build")), false, "nothing is built");
  }
});

test("V01-F1: an image whose Chrome is not the recorded one is refused before any migration or cutover", () => {
  for (const chrome of ["Google Chrome 156.0.8100.12", "Chromium 155.0.8059.39", ""]) {
    const run = runDeploy({ running: ["app"], envLines: [...FLOW_ON, "LA_FLOW_WORKER_CHROME_VERSION=155.0.8059.39"], chrome });
    assert.equal(run.status, 1, chrome);
    assert.match(run.stderr, /Refusing deploy: the Flow worker image reports/);
    assert.ok(position(run.calls, BUILD_ALL) >= 0, "the image was built, then inspected");
    assert.equal(position(run.calls, MIGRATE), -1, "no migration");
    assert.equal(position(run.calls, START_NEW), -1, "no cutover");
    assert.equal(position(run.calls, STOP_APP), -1, "the running release is left untouched");
  }
});

test("V01-F1: an image carrying the recorded Chrome passes the gate", () => {
  const run = runDeploy({ running: [], envLines: [...FLOW_ON, "LA_FLOW_WORKER_CHROME_VERSION=155.0.8059.39"], chrome: "Google Chrome 155.0.8059.39" });
  assert.match(run.stdout, /Flow worker image carries the verified Chrome 155\.0\.8059\.39/);
  assert.doesNotMatch(run.stderr, /Refusing deploy: the Flow worker image/);
});
