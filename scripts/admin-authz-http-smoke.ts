import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { auth } from "../src/auth/server.ts";
import { prisma } from "../src/db/prisma.ts";

const HOST = "127.0.0.1";
const PORT = 3211;
const BASE_URL = `http://${HOST}:${PORT}`;
const nextDevDirectory = new URL("../.next/dev/", import.meta.url);
const require = createRequire(import.meta.url);
const nextCliPath = resolve(dirname(require.resolve("next/package.json")), "dist/bin/next");

const runId = `${Date.now()}-${process.pid}`;
const customerEmail = `admin-http-customer-${runId}@example.invalid`;
const adminEmail = `admin-http-admin-${runId}@example.invalid`;
const password = "admin-http-smoke-password-123";
const productExternalId = `admin-http-product-${runId}`;
const productSlug = `admin-http-product-${runId}`;
const productName = `Admin HTTP Editorial ${runId}`;

let server: ChildProcess | undefined;
let serverOutput = "";

function captureServerOutput(chunk: Buffer) {
  serverOutput = `${serverOutput}${chunk.toString()}`.slice(-16_000);
}

function cookieHeaderFrom(headers: Headers): string {
  return headers
    .getSetCookie()
    .map((cookie) => cookie.split(";", 1)[0])
    .filter(Boolean)
    .join("; ");
}

function decodeHtmlAttribute(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, decimal: string) => String.fromCodePoint(Number.parseInt(decimal, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function serverActionEntries(html: string): Array<[string, string]> {
  const entries: Array<[string, string]> = [];

  for (const inputTag of html.match(/<input\b[^>]*>/g) ?? []) {
    const rawName = inputTag.match(/\bname="([^"]*)"/)?.[1];
    if (!rawName) continue;

    const name = decodeHtmlAttribute(rawName);
    if (!name.startsWith("$ACTION_")) continue;

    const rawValue = inputTag.match(/\bvalue="([^"]*)"/)?.[1] ?? "";
    entries.push([name, decodeHtmlAttribute(rawValue)]);
  }

  return entries;
}

function formContainingField(html: string, fieldName: string): string | null {
  const encodedField = `name="${fieldName}"`;
  for (const formHtml of html.match(/<form\b[\s\S]*?<\/form>/g) ?? []) {
    if (formHtml.includes(encodedField)) return formHtml;
  }
  return null;
}

async function signUpCookie(email: string, name: string, clientIp: string): Promise<string> {
  const { headers } = await auth.api.signUpEmail({
    returnHeaders: true,
    headers: new Headers({ "x-ci-client-ip": clientIp }),
    body: { name, email, password },
  });

  const cookie = cookieHeaderFrom(headers);
  assert.notEqual(cookie, "", `Better Auth must return a session cookie for ${email}`);
  return cookie;
}

async function waitForServer(): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (server?.exitCode !== null && server?.exitCode !== undefined) {
      throw new Error(`Next.js authz smoke server exited early with code ${server.exitCode}\n${serverOutput}`);
    }

    try {
      const response = await fetch(`${BASE_URL}/`, { redirect: "manual" });
      if (response.status < 500) return;
    } catch {
      // The development server may still be starting or compiling the route.
    }

    await delay(500);
  }

  throw new Error(`Timed out waiting for Next.js authz smoke server\n${serverOutput}`);
}

async function waitForServerExit(timeoutMs: number): Promise<boolean> {
  if (!server || server.exitCode !== null) return true;

  const exited = once(server, "exit").then(() => true);
  const timedOut = delay(timeoutMs).then(() => false);
  return Promise.race([exited, timedOut]);
}

async function stopServer() {
  if (!server || server.exitCode !== null) return;

  server.kill("SIGTERM");
  if (await waitForServerExit(5_000)) return;

  server.kill("SIGKILL");
  await waitForServerExit(5_000);
}

async function cleanupDatabase() {
  await prisma.user.deleteMany({
    where: { email: { in: [customerEmail, adminEmail] } },
  });
  await prisma.productMirror.deleteMany({
    where: { pancakeProductId: productExternalId },
  });
}

try {
  await cleanupDatabase();

  const product = await prisma.productMirror.create({
    data: {
      pancakeProductId: productExternalId,
      slug: productSlug,
      name: productName,
      syncedAt: new Date(),
    },
  });

  const customerCookie = await signUpCookie(
    customerEmail,
    "Admin HTTP Customer",
    "203.0.113.11",
  );
  const adminCookie = await signUpCookie(adminEmail, "Admin HTTP Admin", "203.0.113.12");

  await prisma.user.update({
    where: { email: adminEmail },
    data: { role: "ADMIN" },
  });

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

  await waitForServer();

  const customerResponse = await fetch(`${BASE_URL}/admin`, {
    headers: { cookie: customerCookie },
    redirect: "manual",
  });
  assert.equal(
    customerResponse.status,
    404,
    `CUSTOMER must not read /admin, received ${customerResponse.status}`,
  );
  const customerHtml = await customerResponse.text();
  assert.equal(
    customerHtml.includes(productName),
    false,
    "CUSTOMER response must not disclose the protected product list",
  );

  // U14 — the promotion admin surface sits behind the same guard as the rest of /admin, and the
  // activation gate must be visibly off rather than silently absent.
  const customerPromotions = await fetch(`${BASE_URL}/admin/promotions`, {
    headers: { cookie: customerCookie },
    redirect: "manual",
  });
  assert.equal(
    customerPromotions.status,
    404,
    `CUSTOMER must not read /admin/promotions, received ${customerPromotions.status}`,
  );

  const anonymousPromotions = await fetch(`${BASE_URL}/admin/promotions`, { redirect: "manual" });
  assert.ok(
    anonymousPromotions.status === 307
      || anonymousPromotions.status === 302
      || anonymousPromotions.status === 404,
    `anonymous must not read /admin/promotions, received ${anonymousPromotions.status}`,
  );

  const adminPromotions = await fetch(`${BASE_URL}/admin/promotions`, {
    headers: { cookie: adminCookie },
    redirect: "manual",
  });
  assert.equal(
    adminPromotions.status,
    200,
    `ADMIN must read /admin/promotions, received ${adminPromotions.status}`,
  );
  const promotionsHtml = await adminPromotions.text();
  assert.ok(
    promotionsHtml.includes("Kích hoạt khuyến mãi đang tắt"),
    "the promotion admin must state that activation is off while the gate is disabled",
  );

  const editorPath = `/admin/products/${encodeURIComponent(product.id)}`;
  const editorResponse = await fetch(`${BASE_URL}${editorPath}`, {
    headers: { cookie: adminCookie },
    redirect: "manual",
  });
  assert.equal(editorResponse.status, 200, `ADMIN editor must render, received ${editorResponse.status}`);
  const editorHtml = await editorResponse.text();
  assert.ok(editorHtml.includes(productName), "ADMIN editor must render the protected product identity");
  assert.ok(
    editorHtml.includes('name="editorialDescription"'),
    "ADMIN editor must render the editorial form",
  );

  // The product editor now has several independent Server Action forms. Only submit the action
  // metadata belonging to the editorial form; combining $ACTION_* inputs from unrelated forms
  // can produce an action id that Next rightfully rejects as stale/unknown.
  const editorialFormHtml = formContainingField(editorHtml, "editorialDescription");
  assert.ok(editorialFormHtml, "ADMIN editor must render an editorial form boundary");
  const actionEntries = serverActionEntries(editorialFormHtml);
  assert.ok(
    actionEntries.length > 0,
    "ADMIN editorial form must include progressive-enhancement Server Action metadata",
  );

  const editorialDescription = "Authenticated HTTP admin persistence proof.";
  const careInstructions = "Cold wash. Dry in shade.";
  const validSizeGuide = "set-vay-form-rong";
  const invalidSizeGuide = "Relaxed fit. Choose your normal size.";
  const seoTitle = "Authenticated admin HTTP smoke";
  const seoDescription = "Verified through a real authenticated Next.js Server Action request.";

  // 1. Fail-closed rejection: submitting arbitrary/legacy sizeGuide must be refused before any write
  const invalidForm = new FormData();
  for (const [name, value] of actionEntries) {
    invalidForm.append(name, value);
  }
  invalidForm.set("editorialDescription", editorialDescription);
  invalidForm.set("careInstructions", careInstructions);
  invalidForm.set("sizeGuide", invalidSizeGuide);
  invalidForm.set("seoTitle", seoTitle);
  invalidForm.set("seoDescription", seoDescription);

  const invalidResponse = await fetch(`${BASE_URL}${editorPath}`, {
    method: "POST",
    headers: {
      accept: "text/html",
      cookie: adminCookie,
      origin: BASE_URL,
    },
    body: invalidForm,
    redirect: "manual",
  });
  if (!(invalidResponse.status >= 300 && invalidResponse.status < 400)) {
    const responseBody = (await invalidResponse.text()).slice(0, 4_000);
    assert.fail(
      `ADMIN Server Action must redirect on rejected size guide, received ${invalidResponse.status}\n` +
        `Response body:\n${responseBody}\nServer output:\n${serverOutput}`,
    );
  }
  const invalidLocation = invalidResponse.headers.get("location");
  assert.ok(invalidLocation, "ADMIN Server Action reject redirect must include Location");
  const invalidUrl = new URL(invalidLocation, BASE_URL);
  assert.equal(invalidUrl.pathname, editorPath);
  assert.equal(invalidUrl.searchParams.get("error"), "invalid");

  const unwritten = await prisma.productContent.findUnique({
    where: { productId: product.id },
  });
  assert.equal(unwritten, null, "rejected size guide must not persist any product content write");

  // 2. Positive save: submitting approved size-guide ID must succeed and persist
  const form = new FormData();
  for (const [name, value] of actionEntries) {
    form.append(name, value);
  }
  form.set("editorialDescription", editorialDescription);
  form.set("careInstructions", careInstructions);
  form.set("sizeGuide", validSizeGuide);
  form.set("seoTitle", seoTitle);
  form.set("seoDescription", seoDescription);

  const saveResponse = await fetch(`${BASE_URL}${editorPath}`, {
    method: "POST",
    headers: {
      accept: "text/html",
      cookie: adminCookie,
      origin: BASE_URL,
    },
    body: form,
    redirect: "manual",
  });
  if (!(saveResponse.status >= 300 && saveResponse.status < 400)) {
    const responseBody = (await saveResponse.text()).slice(0, 4_000);
    assert.fail(
      `ADMIN Server Action must redirect after save, received ${saveResponse.status}\n` +
        `Response body:\n${responseBody}\nServer output:\n${serverOutput}`,
    );
  }

  const saveLocation = saveResponse.headers.get("location");
  assert.ok(saveLocation, "ADMIN Server Action redirect must include Location");
  const savedUrl = new URL(saveLocation, BASE_URL);
  assert.equal(savedUrl.pathname, editorPath);
  assert.equal(savedUrl.searchParams.get("saved"), "1");

  const persisted = await prisma.productContent.findUnique({
    where: { productId: product.id },
    select: {
      editorialDescription: true,
      careInstructions: true,
      sizeGuide: true,
      seoTitle: true,
      seoDescription: true,
    },
  });
  assert.deepEqual(persisted, {
    editorialDescription,
    careInstructions,
    sizeGuide: validSizeGuide,
    seoTitle,
    seoDescription,
  });

  const savedPageResponse = await fetch(savedUrl, {
    headers: { cookie: adminCookie },
    redirect: "manual",
  });
  assert.equal(savedPageResponse.status, 200);
  const savedPageHtml = await savedPageResponse.text();
  assert.ok(
    savedPageHtml.includes("Đã lưu nội dung biên tập."),
    "redirect target must render the persisted success status",
  );

  // U25 / #153 M3 — the same authenticated boundary must govern the website-owned Merchant apparel
  // overrides, and a value outside the reviewed allowlist must be refused by the server rather than
  // by the select element that happened to render it.
  const merchantFormHtml = formContainingField(savedPageHtml, "ageGroup");
  assert.ok(merchantFormHtml, "ADMIN editor must render the Merchant apparel form boundary");
  const merchantActionEntries = serverActionEntries(merchantFormHtml);
  assert.ok(
    merchantActionEntries.length > 0,
    "ADMIN Merchant apparel form must include progressive-enhancement Server Action metadata",
  );

  async function submitMerchantFacts(
    values: Readonly<Record<string, string>>,
    cookie: string | null,
  ) {
    const merchantForm = new FormData();
    for (const [name, value] of merchantActionEntries) {
      merchantForm.append(name, value);
    }
    for (const [name, value] of Object.entries(values)) {
      merchantForm.set(name, value);
    }

    return fetch(`${BASE_URL}${editorPath}`, {
      method: "POST",
      headers: {
        accept: "text/html",
        origin: BASE_URL,
        ...(cookie === null ? {} : { cookie }),
      },
      body: merchantForm,
      redirect: "manual",
    });
  }

  const merchantSave = await submitMerchantFacts(
    { gender: "unisex", ageGroup: "kids", condition: "USE_SHOP_DEFAULT" },
    adminCookie,
  );
  assert.ok(
    merchantSave.status >= 300 && merchantSave.status < 400,
    `ADMIN Merchant apparel save must redirect, received ${merchantSave.status}`,
  );
  const merchantSavedUrl = new URL(
    merchantSave.headers.get("location") ?? "",
    BASE_URL,
  );
  assert.equal(merchantSavedUrl.searchParams.get("merchantSaved"), "1");
  assert.deepEqual(
    await prisma.productMerchantFacts.findUnique({
      where: { productId: product.id },
      select: { gender: true, ageGroup: true, condition: true },
    }),
    { gender: "UNISEX", ageGroup: "KIDS", condition: null },
  );

  const rejectedMerchantSave = await submitMerchantFacts(
    { gender: "nam", ageGroup: "kids", condition: "USE_SHOP_DEFAULT" },
    adminCookie,
  );
  const rejectedUrl = new URL(rejectedMerchantSave.headers.get("location") ?? "", BASE_URL);
  assert.equal(rejectedUrl.searchParams.get("merchantError"), "1");
  assert.deepEqual(
    await prisma.productMerchantFacts.findUnique({
      where: { productId: product.id },
      select: { gender: true, ageGroup: true, condition: true },
    }),
    { gender: "UNISEX", ageGroup: "KIDS", condition: null },
    "a refused submission must leave the stored override untouched",
  );

  const customerMerchantSave = await submitMerchantFacts(
    { gender: "female", ageGroup: "adult", condition: "used" },
    customerCookie,
  );
  // The action throws `AuthorizationError` before it reaches any write, so the response must not be
  // the success redirect. Whether Next surfaces that as an error status or an error redirect is its
  // own concern; what must never happen is a `merchantSaved` outcome.
  assert.notEqual(
    new URL(customerMerchantSave.headers.get("location") ?? BASE_URL, BASE_URL).searchParams.get(
      "merchantSaved",
    ),
    "1",
    "a non-admin submission must never reach the saved outcome",
  );
  assert.deepEqual(
    await prisma.productMerchantFacts.findUnique({
      where: { productId: product.id },
      select: { gender: true, ageGroup: true, condition: true },
    }),
    { gender: "UNISEX", ageGroup: "KIDS", condition: null },
    "a non-admin must not be able to write website-owned Merchant apparel facts",
  );

  console.log(
    "Authenticated admin HTTP smoke passed: CUSTOMER denied, ADMIN editor rendered, ADMIN Server Action persisted ProductContent, and Merchant apparel overrides enforced authorization plus the server-side allowlist.",
  );
} finally {
  await stopServer();
  await rm(nextDevDirectory, { recursive: true, force: true });
  await cleanupDatabase();
  await prisma.$disconnect();
}