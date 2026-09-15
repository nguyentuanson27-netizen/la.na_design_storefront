import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const HOST = "127.0.0.1";
const PORT = 3222;
const BASE_URL = `http://${HOST}:${PORT}`;
const nextDevDirectory = new URL("../.next/dev/", import.meta.url);
const require = createRequire(import.meta.url);
const nextCliPath = resolve(dirname(require.resolve("next/package.json")), "dist/bin/next");

let server: ChildProcess | undefined;
let serverOutput = "";

function captureServerOutput(chunk: Buffer) {
  serverOutput = `${serverOutput}${chunk.toString()}`.slice(-20_000);
}

async function waitForServer(): Promise<void> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (server?.exitCode !== null && server?.exitCode !== undefined) {
      throw new Error(`Next.js P16C robots server exited early with code ${server.exitCode}\n${serverOutput}`);
    }

    try {
      const response = await fetch(`${BASE_URL}/robots.txt`, { redirect: "manual" });
      if (response.status < 500) return;
    } catch {
      // The development server may still be starting or compiling the route.
    }

    await delay(500);
  }

  throw new Error(`Timed out waiting for Next.js P16C robots server\n${serverOutput}`);
}

async function waitForServerExit(timeoutMs: number): Promise<boolean> {
  if (!server || server.exitCode !== null) return true;
  return Promise.race([
    once(server, "exit").then(() => true),
    delay(timeoutMs).then(() => false),
  ]);
}

async function stopServer() {
  if (!server || server.exitCode !== null) return;
  server.kill("SIGTERM");
  if (await waitForServerExit(5_000)) return;
  server.kill("SIGKILL");
  await waitForServerExit(5_000);
}

function userAgentSection(body: string, userAgent: string): string[] {
  const lines = body.split(/\r?\n/).map((line) => line.trim());
  const start = lines.findIndex((line) => line.toLowerCase() === `user-agent: ${userAgent}`.toLowerCase());
  assert.notEqual(start, -1, `robots.txt must contain User-Agent: ${userAgent}`);

  const section: string[] = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line.toLowerCase().startsWith("user-agent:")) break;
    if (line.length > 0) section.push(line);
  }
  return section;
}

import { ALL_APPROVED_NAMED_CRAWLERS } from "../src/seo/robots-policy.ts";
import { OFFICIAL_PRODUCTION_STOREFRONT_HOST } from "../src/commerce/storefront-origin.ts";

try {
  serverOutput = "";
  server = spawn(
    process.execPath,
    [nextCliPath, "dev", "--hostname", HOST, "--port", String(PORT)],
    {
      env: {
        ...process.env,
        APP_DOMAIN: OFFICIAL_PRODUCTION_STOREFRONT_HOST,
        SEARCH_INDEXING_ENABLED: "true",
        NEXT_TELEMETRY_DISABLED: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  server.stdout?.on("data", captureServerOutput);
  server.stderr?.on("data", captureServerOutput);
  await waitForServer();

  const response = await fetch(`${BASE_URL}/robots.txt`, { redirect: "manual" });
  const body = await response.text();
  assert.equal(response.status, 200, `P16C / U36 robots.txt must return 200\n${serverOutput}`);

  const wildcardRules = userAgentSection(body, "*");
  assert.equal(wildcardRules.includes("Allow: /"), true, "* must be allowed on public HTML");
  assert.equal(wildcardRules.includes("Disallow: /api"), true, "* must remain blocked from /api");
  assert.equal(wildcardRules.includes("Disallow: /"), false, "* must not be globally blocked");

  for (const crawler of ALL_APPROVED_NAMED_CRAWLERS) {
    const crawlerRules = userAgentSection(body, crawler);
    assert.equal(crawlerRules.includes("Allow: /"), true, `${crawler} must be allowed on public HTML`);
    assert.equal(crawlerRules.includes("Disallow: /api"), true, `${crawler} must remain blocked from /api`);
    assert.equal(crawlerRules.includes("Disallow: /"), false, `${crawler} must not be globally blocked`);
  }

  assert.equal(body.includes(`Sitemap: https://${OFFICIAL_PRODUCTION_STOREFRONT_HOST}/sitemap.xml`), true);

  console.log(`U36 / P16C robots HTTP smoke passed: wildcard and all ${ALL_APPROVED_NAMED_CRAWLERS.length} approved crawlers can crawl public HTML, /api remains blocked, and canonical sitemap is advertised when indexing is enabled.`);
} finally {
  await stopServer();
  await rm(nextDevDirectory, { recursive: true, force: true });
}
