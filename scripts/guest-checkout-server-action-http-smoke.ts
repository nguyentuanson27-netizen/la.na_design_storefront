import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { readAuthServerConfig } from "../src/auth/config.ts";
import { prisma } from "../src/db/prisma.ts";
import { deriveGuestCheckoutClientKey } from "../src/commerce/guest-checkout-client-identity.ts";

const HOST = "127.0.0.1";
const PORT = 3213;
const BASE_URL = `http://${HOST}:${PORT}`;
const PROBE_PATH = "/guest-checkout-action-http-smoke-probe";
const probeDirectory = new URL("../src/app/guest-checkout-action-http-smoke-probe/", import.meta.url);
const probePage = new URL("page.tsx", probeDirectory);
const tsconfigPath = new URL("../tsconfig.json", import.meta.url);
const nextDevDirectory = new URL("../.next/dev/", import.meta.url);
const require = createRequire(import.meta.url);
const nextCliPath = resolve(dirname(require.resolve("next/package.json")), "dist/bin/next");

const runId = `${Date.now()}-${process.pid}`;
const publicCode = `LA-checkout-action-http-smoke-${runId}`;
const clientIp = "203.0.113.10";
const shopId = Number(process.env.PANCAKE_SHOP_ID);

assert.ok(Number.isSafeInteger(shopId) && shopId > 0, "PANCAKE_SHOP_ID must be a positive integer for the checkout smoke");

let server: ChildProcess | undefined;
let serverOutput = "";
let originalTsconfig: string | undefined;
let cartId: string | undefined;
let clientBucketId: string | undefined;

function captureServerOutput(chunk: Buffer) {
  serverOutput = `${serverOutput}${chunk.toString()}`.slice(-12_000);
}

async function waitForProbePage(): Promise<string> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (server?.exitCode !== null && server?.exitCode !== undefined) {
      throw new Error(`Next.js checkout probe server exited early with code ${server.exitCode}\n${serverOutput}`);
    }

    try {
      const response = await fetch(`${BASE_URL}${PROBE_PATH}`);
      if (response.ok) return await response.text();
    } catch {
      // The development server may still be starting or compiling the temporary route.
    }

    await delay(500);
  }

  throw new Error(`Timed out waiting for guest checkout Server Action probe route\n${serverOutput}`);
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

async function cleanupDatabase() {
  // I6b — `onDelete: Restrict` on both reservation relations (ADR 0014 §13) means the ledger has to
  // be cleared before its order can go. That restriction is deliberate: cascading a hold away with
  // its order would silently free capacity that is still counting.
  await prisma.variantCapacityReservation.deleteMany({
    where: { order: { publicCode } },
  });
  await prisma.orderMirror.deleteMany({ where: { publicCode } });
  if (cartId) {
    await prisma.rateLimit.deleteMany({
      where: {
        id: {
          in: [`checkout:${cartId}`, ...(clientBucketId ? [clientBucketId] : [])],
        },
      },
    });
    await prisma.cart.deleteMany({ where: { id: cartId } });
  }
}

try {
  const authConfig = readAuthServerConfig();
  assert.ok(authConfig.ipAddressHeader, "checkout smoke requires the trusted proxy client-IP header");
  const expectedClientKey = deriveGuestCheckoutClientKey(
    {
      get(name: string) {
        return name === authConfig.ipAddressHeader ? clientIp : null;
      },
    },
    authConfig,
  );
  clientBucketId = `checkout-client:${expectedClientKey}`;

  const cart = await prisma.cart.create({
    data: { expiresAt: new Date(Date.now() + 5 * 60_000) },
  });
  cartId = cart.id;

  await prisma.orderMirror.create({
    data: {
      publicCode,
      sourceCartId: cart.id,
      pancakeShopId: shopId,
      pancakeOrderId: "990001",
      state: "CONFIRMED",
      checkoutSnapshottedAt: new Date(),
      guestName: "Checkout Smoke",
      guestPhone: "0901234567",
      provinceRef: "province-smoke",
      districtRef: "district-smoke",
      communeRef: "commune-smoke",
      addressDetail: "12 Checkout Smoke",
      merchandiseSubtotalVnd: BigInt(500_000),
      shippingFeeVnd: BigInt(30_000),
      totalVnd: BigInt(530_000),
    },
  });

  originalTsconfig = await readFile(tsconfigPath, "utf-8");
  await mkdir(probeDirectory, { recursive: true });
  await writeFile(
    probePage,
    `import { submitGuestCheckoutAction } from "../../commerce/guest-checkout-actions.ts";\n\nexport const dynamic = "force-dynamic";\n\nexport default function GuestCheckoutActionHttpSmokePage() {\n  async function submitCheckout(formData: FormData) {\n    "use server";\n    await submitGuestCheckoutAction(null, formData);\n  }\n\n  return (\n    <form action={submitCheckout}>\n      <input name="name" defaultValue="Checkout Smoke" />\n      <input name="phone" defaultValue="0901234567" />\n      <input name="provinceRef" defaultValue="province-smoke" />\n      <input name="districtRef" defaultValue="district-smoke" />\n      <input name="communeRef" defaultValue="commune-smoke" />\n      <input name="detail" defaultValue="12 Checkout Smoke" />\n      <input name="note" defaultValue="" />\n      <button type="submit">Submit checkout</button>\n    </form>\n  );\n}\n`,
    "utf-8",
  );

  const spawnedServer = spawn(
    process.execPath,
    [nextCliPath, "dev", "--hostname", HOST, "--port", String(PORT)],
    {
      env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  server = spawnedServer;
  spawnedServer.stdout?.on("data", captureServerOutput);
  spawnedServer.stderr?.on("data", captureServerOutput);

  const html = await waitForProbePage();
  const actionField = html.match(/name="(\$ACTION_[^"]+)"/)?.[1];
  assert.ok(actionField, "server-rendered checkout form must expose a progressive-enhancement Server Action field");

  const form = new FormData();
  form.set(actionField, "");
  form.set("name", "Checkout Smoke");
  form.set("phone", "0901234567");
  form.set("provinceRef", "province-smoke");
  form.set("districtRef", "district-smoke");
  form.set("communeRef", "commune-smoke");
  form.set("detail", "12 Checkout Smoke");
  form.set("note", "");

  const response = await fetch(`${BASE_URL}${PROBE_PATH}`, {
    method: "POST",
    headers: {
      accept: "text/html",
      cookie: `la_cart=${cart.id}`,
      origin: BASE_URL,
      [authConfig.ipAddressHeader]: clientIp,
    },
    body: form,
    redirect: "manual",
  });

  assert.ok(response.status >= 200 && response.status < 400, `unexpected checkout action status ${response.status}`);
  const setCookie = response.headers.get("set-cookie");
  assert.ok(setCookie, "confirmed checkout must emit a cart-clearing Set-Cookie header");
  assert.match(setCookie, /(?:^|,\s*)la_cart=;/);
  assert.match(setCookie, /Max-Age=0/i);
  assert.match(setCookie, /HttpOnly/i);
  assert.match(setCookie, /SameSite=Lax/i);
  assert.match(setCookie, /Path=\//i);

  const [cartBucket, clientBucket, order] = await Promise.all([
    prisma.rateLimit.findUnique({ where: { id: `checkout:${cart.id}` } }),
    prisma.rateLimit.findUnique({ where: { id: clientBucketId } }),
    prisma.orderMirror.findUnique({ where: { publicCode } }),
  ]);
  assert.equal(cartBucket?.count, 1, "real Server Action must consume the cart checkout bucket");
  assert.equal(clientBucket?.count, 1, "real Server Action must consume the trusted-client checkout bucket");
  assert.equal(order?.state, "CONFIRMED");
  assert.equal(order?.pancakeOrderId, "990001");

  console.log("Guest checkout Server Action HTTP smoke passed: request cookie and trusted client identity reached both limiters, confirmed fast-path cleared the cart cookie, and no live Pancake order was needed.");
} finally {
  await stopServer();
  await rm(probeDirectory, { recursive: true, force: true });
  await rm(nextDevDirectory, { recursive: true, force: true });
  if (originalTsconfig !== undefined) await writeFile(tsconfigPath, originalTsconfig, "utf-8");
  await cleanupDatabase();
  await prisma.$disconnect();
}
