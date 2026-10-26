import { spawn, spawnSync, type ChildProcess, type SpawnSyncOptions } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

/**
 * H3-V browser evidence for the voucher hold (V12, AC-42 / AC-43), without putting any test code in production.
 *
 *   1. OFFICIAL artifact: a temporary git worktree of HEAD, built exactly as production is built (`next build`).
 *      Proved clean: no harness route in any manifest or output file, no reference to the hold Server Action, and
 *      the harness URL answers 404 even with `LA_VOUCHER_TEST_HARNESS=true` in the server's environment.
 *   2. TEST artifact: a second worktree of the same HEAD into whose `src/app` the route from
 *      `tests/fixtures/voucher-hold-harness/app` is copied, built and served with `next start`. Playwright drives the
 *      REAL Server Action against it (tests/a11y-runtime/voucher-hold-harness.spec.ts). The artifact is deleted when
 *      the run ends and is never deployed.
 *
 * Needs: DATABASE_URL (a disposable PostgreSQL with the migrations applied) and BETTER_AUTH_SECRET (>= 32 chars).
 * No Pancake call is made. Nothing sensitive is printed: server output is scrubbed and only its tail is shown on failure.
 * Set HARNESS_EVIDENCE_OUT=<path> to write the sanitized evidence JSON.
 */

const ROOT = resolve(import.meta.dirname, "..");
const SHOP = 940_030;
const CLEAN_PORT = Number(process.env.HARNESS_CLEAN_PORT ?? 3470);
const TEST_PORT = Number(process.env.HARNESS_TEST_PORT ?? 3471);
const ROUTE = "voucher-hold-harness";
const FIXTURE = `tests/fixtures/${ROUTE}/app/${ROUTE}`;
const ACTION = "holdStorefrontVouchers";
const DIST = ".next-vhh";

const DATABASE_URL = process.env.DATABASE_URL ?? "";
const SECRET = process.env.BETTER_AUTH_SECRET ?? "";
if (!DATABASE_URL) throw new Error("DATABASE_URL is required (a disposable database with the migrations applied)");
if (SECRET.trim().length < 32) throw new Error("BETTER_AUTH_SECRET must contain at least 32 characters");

const dbPassword = (() => { try { return new URL(DATABASE_URL).password; } catch { return ""; } })();
function scrub(text: string): string {
  let out = text;
  for (const secret of [SECRET, dbPassword]) if (secret.length >= 6) out = out.split(secret).join("[redacted]");
  return out.replace(/la_cart=[^;\s"']+/g, "la_cart=[redacted]");
}
const log = (message: string) => console.log(`[voucher-hold-harness] ${scrub(message)}`);

function runEnv(port: number, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    NODE_ENV: "production",
    NEXT_DIST_DIR: DIST,
    NEXT_TELEMETRY_DISABLED: "1",
    DATABASE_URL,
    BETTER_AUTH_SECRET: SECRET,
    BETTER_AUTH_URL: `http://127.0.0.1:${port}`,
    BETTER_AUTH_IP_HEADER: "x-ci-client-ip",
    APP_DOMAIN: `127.0.0.1:${port}`,
    SEARCH_INDEXING_ENABLED: "false",
    PANCAKE_SHOP_ID: String(SHOP),
    LA_VOUCHER_ENABLED: "true",
    LA_PANCAKE_VOUCHER_VERIFIED_SHOP_IDS: String(SHOP),
    LA_TRACKING_MODE: "preview",
    LA_GTM_CONTAINER_ID: "GTM-VCHRTST",
    ...extra,
  };
}

function sh(command: string, args: string[], options: SpawnSyncOptions & { label: string }): void {
  const { label, ...spawnOptions } = options;
  const result = spawnSync(command, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...spawnOptions });
  if (result.status !== 0) {
    const tail = scrub(`${String(result.stdout ?? "")}${String(result.stderr ?? "")}`).slice(-4000);
    throw new Error(`${label} failed (exit ${String(result.status)})\n${tail}`);
  }
}

function walk(dir: string, visit: (file: string) => void): void {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stats = statSync(full);
    if (stats.isDirectory()) walk(full, visit);
    else visit(full);
  }
}

const work = mkdtempSync(join(dirname(ROOT), ".la-vhh-"));
const servers: ChildProcess[] = [];
const trees: string[] = [];
const tails = new Map<ChildProcess, string>();

function prepareTree(label: "official" | "harness"): string {
  const dir = join(work, label);
  sh("git", ["worktree", "add", "--detach", dir, "HEAD"], { cwd: ROOT, label: `git worktree add (${label})` });
  trees.push(dir);
  log(`${label}: installing dependencies from the lockfile`);
  sh("pnpm", ["install", "--frozen-lockfile", "--ignore-scripts", "--prefer-offline"], { cwd: dir, label: `pnpm install (${label})`, env: { ...process.env, CI: "true" } });
  sh("pnpm", ["prisma:generate"], { cwd: dir, label: `prisma generate (${label})`, env: runEnv(CLEAN_PORT) });
  return dir;
}

function build(dir: string, label: string, port: number): void {
  log(`${label}: next build (production)`);
  sh(process.execPath, [join(dir, "node_modules/next/dist/bin/next"), "build"], { cwd: dir, label: `next build (${label})`, env: runEnv(port) });
}

async function serve(dir: string, port: number, extra: Record<string, string> = {}): Promise<ChildProcess> {
  const child = spawn(process.execPath, [join(dir, "node_modules/next/dist/bin/next"), "start", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: dir,
    env: runEnv(port, extra),
    stdio: ["ignore", "pipe", "pipe"],
  });
  tails.set(child, "");
  const keep = (chunk: Buffer) => tails.set(child, (tails.get(child) + chunk.toString()).slice(-6000));
  child.stdout?.on("data", keep);
  child.stderr?.on("data", keep);
  servers.push(child);
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      await fetch(`http://127.0.0.1:${port}/robots.txt`);
      return child;
    } catch { /* not listening yet */ }
    if (child.exitCode !== null) throw new Error(`next start exited early\n${scrub(tails.get(child) ?? "")}`);
    await delay(500);
  }
  throw new Error(`next start did not come up\n${scrub(tails.get(child) ?? "")}`);
}

type Check = { name: string; ok: boolean; detail: string };
const checks: Check[] = [];
function check(name: string, ok: boolean, detail: string): void {
  checks.push({ name, ok, detail });
  log(`${ok ? "PASS" : "FAIL"} ${name} — ${detail}`);
}

function distOf(dir: string): string { return join(dir, DIST); }
function manifestText(dir: string, relative: string): string | null {
  const file = join(distOf(dir), relative);
  return existsSync(file) ? readFileSync(file, "utf8") : null;
}
function occurrences(dir: string, needle: string): number {
  let hits = 0;
  for (const sub of ["server", "static"]) {
    const root = join(distOf(dir), sub);
    if (!existsSync(root)) continue;
    walk(root, (file) => {
      if (!/\.(js|json|html|rsc|body|meta|txt|map)$/.test(file)) return;
      if (readFileSync(file, "utf8").includes(needle)) hits += 1;
    });
  }
  return hits;
}
const MANIFESTS = ["app-path-routes-manifest.json", "routes-manifest.json", "server/app-paths-manifest.json", "build-manifest.json", "prerender-manifest.json", "server/server-reference-manifest.json", "required-server-files.json"];

async function status(port: number, path: string): Promise<number> {
  return (await fetch(`http://127.0.0.1:${port}${path}`, { redirect: "manual" })).status;
}

async function main(): Promise<number> {
  const commit = spawnSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).stdout.trim();
  const dirty = spawnSync("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: ROOT, encoding: "utf8" }).stdout.trim();
  if (dirty) throw new Error("Tracked files have uncommitted changes. The evidence names a commit, so build exactly that commit: commit or stash first.");
  log(`commit ${commit}`);
  const evidence: Record<string, unknown> = { commit, node: process.version, startedAt: new Date().toISOString() };

  // 1. The official artifact: built from the clean commit, exactly as production is.
  const official = prepareTree("official");
  build(official, "official", CLEAN_PORT);
  check("official build: no harness route directory", !existsSync(join(distOf(official), "server/app", ROUTE)), `${DIST}/server/app/${ROUTE} absent`);
  for (const manifest of MANIFESTS) {
    const text = manifestText(official, manifest);
    if (text === null) continue;
    check(`official build: ${manifest} names no harness route`, !text.includes(ROUTE), "no occurrence");
    check(`official build: ${manifest} names no hold action`, !text.includes(ACTION), "no occurrence");
  }
  const routeHits = occurrences(official, ROUTE);
  const actionHits = occurrences(official, ACTION);
  check("official build: no output file mentions the harness route", routeHits === 0, `${routeHits} file(s)`);
  check("official build: no output file mentions the hold Server Action", actionHits === 0, `${actionHits} file(s) — the action is not reachable from any production page`);
  await serve(official, CLEAN_PORT, { LA_VOUCHER_TEST_HARNESS: "true" }); // someone sets a test variable by mistake
  const officialStatuses = { harness: await status(CLEAN_PORT, `/${ROUTE}`), other: await status(CLEAN_PORT, `/${ROUTE}/other`), cart: await status(CLEAN_PORT, "/cart") };
  check("official server with LA_VOUCHER_TEST_HARNESS=true: harness URL is 404", officialStatuses.harness === 404 && officialStatuses.other === 404, `GET /${ROUTE} → ${officialStatuses.harness}, /${ROUTE}/other → ${officialStatuses.other}`);
  check("official server answers a real page", officialStatuses.cart === 200, `GET /cart → ${officialStatuses.cart}`);
  evidence.officialArtifact = { routeFileHits: routeHits, actionFileHits: actionHits, statuses: officialStatuses, manifestsChecked: MANIFESTS.filter((m) => manifestText(official, m) !== null) };

  // 2. The test artifact: the same commit plus the fixture route.
  const harness = prepareTree("harness");
  cpSync(join(harness, FIXTURE), join(harness, "src/app", ROUTE), { recursive: true });
  build(harness, "harness", TEST_PORT);
  const routes = manifestText(harness, "app-path-routes-manifest.json") ?? "";
  check("test build: the harness route IS present (positive control)", routes.includes(`/${ROUTE}/page`), "app-path-routes-manifest.json lists it");
  check("test build: the hold action IS present (positive control)", occurrences(harness, ACTION) > 0, `${occurrences(harness, ACTION)} file(s)`);
  await serve(harness, TEST_PORT);

  // 3. Playwright against the real Server Action.
  const evidencePath = join(work, "spec-evidence.json");
  const cli = [process.env.PLAYWRIGHT_CLI, join(ROOT, "tests/a11y-runtime/node_modules/@playwright/test/cli.js"), join(ROOT, "node_modules/@playwright/test/cli.js")].find((candidate) => candidate && existsSync(candidate));
  if (!cli) throw new Error("Playwright is not installed (npm ci in tests/a11y-runtime, or set PLAYWRIGHT_CLI)");
  log("playwright: voucher-hold-harness.spec.ts");
  const run = spawnSync(process.execPath, [cli, "test", "--config", "voucher-hold-harness.config.ts"], {
    cwd: join(ROOT, "tests/a11y-runtime"),
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, DATABASE_URL, PANCAKE_SHOP_ID: String(SHOP), BETTER_AUTH_SECRET: SECRET, LA_VOUCHER_ENABLED: "true", HARNESS_BASE_URL: `http://127.0.0.1:${TEST_PORT}`, HARNESS_SHOP: String(SHOP), HARNESS_EVIDENCE_PATH: evidencePath },
  });
  console.log(scrub(`${run.stdout ?? ""}${run.stderr ?? ""}`).slice(-6000));
  check("playwright: every voucher-hold scenario passed", run.status === 0, `exit ${String(run.status)}`);
  evidence.scenarios = existsSync(evidencePath) ? JSON.parse(readFileSync(evidencePath, "utf8")) : null;
  evidence.checks = checks;
  evidence.finishedAt = new Date().toISOString();
  const out = process.env.HARNESS_EVIDENCE_OUT;
  if (out) {
    mkdirSync(dirname(resolve(out)), { recursive: true });
    writeFileSync(resolve(out), `${JSON.stringify(evidence, null, 2)}\n`);
    log(`evidence written to ${out}`);
  }
  return checks.every((entry) => entry.ok) ? 0 : 1;
}

async function cleanup(): Promise<void> {
  for (const server of servers) {
    if (server.exitCode === null) {
      server.kill("SIGTERM");
      await Promise.race([new Promise((done) => server.once("exit", done)), delay(4000)]);
      if (server.exitCode === null) server.kill("SIGKILL");
    }
  }
  for (const tree of trees) spawnSync("git", ["worktree", "remove", "--force", tree], { cwd: ROOT });
  spawnSync("git", ["worktree", "prune"], { cwd: ROOT });
  rmSync(work, { recursive: true, force: true }); // the test artifact is never kept, let alone deployed
}

let exitCode = 1;
try {
  exitCode = await main();
} catch (error) {
  console.error(scrub(error instanceof Error ? error.message : String(error)));
} finally {
  await cleanup();
}
process.exit(exitCode);
