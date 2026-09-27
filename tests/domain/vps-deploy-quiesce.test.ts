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
  *" exec -T postgres "*) echo fake-dump ;;
esac
`;

type Run = { status: number | null; calls: string[]; stderr: string };

type ScriptRun = {
  running: readonly ("app" | "catalog-sync")[];
  migrateExit?: number;
  reconcileExit?: number;
  syncHealth?: "healthy" | "unhealthy";
  images?: readonly string[];
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
  { running, migrateExit = 0, reconcileExit = 0, syncHealth = "healthy", images = [] }: ScriptRun,
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
      `DEPLOY_TARGET=production\nRELEASE_SHA=${git("rev-parse", "HEAD")}\n`,
    );

    writeFileSync(join(bin, "docker"), FAKE_DOCKER);
    chmodSync(join(bin, "docker"), 0o755);
    for (const service of running) writeFileSync(join(state, `${service}-running`), "");
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
        FAKE_IMAGES: images.join(" "),
        BACKUP_DIR: join(root, "backups"),
      },
      encoding: "utf8",
    });
    const calls = readFileSync(callLog, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => line.replace(/^compose --env-file \S+ -f \S+ /, ""));
    return { status: result.status, calls, stderr: result.stderr };
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
