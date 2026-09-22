/**
 * U12 / M2 — `/shop/<slug>?variant=<pancakeVariationId>` over real HTTP.
 *
 * This contract is URL → rendered UI, so a unit test on the resolver proves only half of it. What
 * matters to a shopper arriving from a feed link is that the served page comes back with the right
 * option already chosen and the right price shown, and that a hostile or stale value degrades to
 * the ordinary product page rather than to a wrong or unauthorized one.
 *
 * The search-exposure consequences are asserted here too, on the same server: the deep link must
 * not create a second canonical or become independently indexable.
 */

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { prisma } from "../src/db/prisma.ts";
import { OFFICIAL_PRODUCTION_STOREFRONT_HOST } from "../src/commerce/storefront-origin.ts";

const HOST = "127.0.0.1";
const PORT = 3219;
const BASE_URL = `http://${HOST}:${PORT}`;
const SHOP_ID = 920_012;
const PUBLIC_ORIGIN = `https://${OFFICIAL_PRODUCTION_STOREFRONT_HOST}`;
const nextDevDirectory = new URL("../.next/dev/", import.meta.url);
const require = createRequire(import.meta.url);
const nextCliPath = resolve(dirname(require.resolve("next/package.json")), "dist/bin/next");

const runId = `${Date.now()}-${process.pid}`;
const productId = `u12-http-product-${runId}`;
const otherProductId = `u12-http-other-${runId}`;
const slug = `u12-deep-link-${runId}`;
const otherSlug = `u12-other-${runId}`;

const MEDIUM_VARIATION = `u12-pv-medium-${runId}`;
const LARGE_VARIATION = `u12-pv-large-${runId}`;
const SOLD_OUT_VARIATION = `u12-pv-soldout-${runId}`;
const INACTIVE_VARIATION = `u12-pv-inactive-${runId}`;
const OTHER_PRODUCT_VARIATION = `u12-pv-foreign-${runId}`;

const MEDIUM_PRICE = 890_000;
const LARGE_PRICE = 910_000;
const SOLD_OUT_PRICE = 777_000;
const PRIMARY_IMAGE = "https://content.pancake.vn/catalog/11/22/33/u12-primary.jpg";
const MEDIUM_IMAGE = "https://content.pancake.vn/catalog/11/22/33/u12-medium.jpg";
const LARGE_IMAGE = "https://content.pancake.vn/catalog/11/22/33/u12-large.jpg";

let server: ChildProcess | undefined;
let serverOutput = "";
/** Set by the seeding step so the local CUID can be asserted non-addressable. */
let mediumVariantMirrorId = "";

type HttpResponse = Readonly<{ status: number; body: string; xRobotsTag: string | null }>;

function captureServerOutput(chunk: Buffer) {
  serverOutput = `${serverOutput}${chunk.toString()}`.slice(-20_000);
}

async function requestPath(path: string): Promise<HttpResponse> {
  const response = await fetch(`${BASE_URL}${path}`, { redirect: "manual" });
  return {
    status: response.status,
    body: await response.text(),
    xRobotsTag: response.headers.get("x-robots-tag"),
  };
}

async function waitForServer(): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const response = await fetch(`${BASE_URL}/shop/${slug}`, { redirect: "manual" });
      if (response.status < 500) {
        await response.arrayBuffer();
        return;
      }
    } catch {
      // still starting
    }
    await delay(500);
  }
  throw new Error(`U12 smoke server did not start\n${serverOutput}`);
}

async function stopServer() {
  if (!server || server.exitCode !== null) return;
  server.kill("SIGTERM");
  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (server.exitCode !== null) return;
    await delay(500);
  }
  server.kill("SIGKILL");
}

async function startServer(environment: Record<string, string>) {
  serverOutput = "";
  const spawnedServer = spawn(
    process.execPath,
    [nextCliPath, "dev", "--hostname", HOST, "--port", String(PORT)],
    {
      env: {
        ...process.env,
        ...environment,
        PANCAKE_SHOP_ID: String(SHOP_ID),
        NEXT_TELEMETRY_DISABLED: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  server = spawnedServer;
  spawnedServer.stdout?.on("data", captureServerOutput);
  spawnedServer.stderr?.on("data", captureServerOutput);
  await waitForServer();
}

async function cleanupDatabase() {
  await prisma.productMirror.deleteMany({
    where: { pancakeProductId: { in: [productId, otherProductId] } },
  });
}

/**
 * A radio input is rendered checked by React SSR, so the served HTML is enough to prove which
 * option the page opened with — no client run required to observe the server's decision.
 */
function assertChoiceChecked(body: string, name: string, value: string, label: string) {
  // Attribute order in the serialized markup is React's business, not this contract's, so each
  // input tag is inspected as a set of attributes rather than matched as an ordered string.
  const inputs = body.match(/<input\b[^>]*>/g) ?? [];
  const matched = inputs.filter(
    (tag) => tag.includes(`name="${name}"`) && tag.includes(`value="${value}"`),
  );
  assert.equal(matched.length, 1, `${label}: expected exactly one ${name}=${value} input`);
  assert.ok(
    matched[0]!.includes('checked=""'),
    `${label}: expected ${name}=${value} to render checked, got ${matched[0]}`,
  );
}

function assertNoChoiceChecked(body: string, label: string) {
  // Inspected per tag rather than as an ordered string, for the same reason as the positive
  // assertion: React decides attribute order, and a negative assertion that silently stops
  // matching is worse than one that fails.
  const inputs = body.match(/<input\b[^>]*>/g) ?? [];
  const preselected = inputs.filter(
    (tag) =>
      (tag.includes('name="storefront-size"') || tag.includes('name="storefront-color"'))
      && tag.includes('checked=""'),
  );
  assert.deepEqual(preselected, [], `${label}: no option may render preselected`);
}

function serves(frame: string, urlFragment: string) {
  // Next's image loader percent-encodes the source into the `/_next/image?url=` query, so a frame
  // may carry either spelling depending on whether the URL was rewritten.
  return frame.includes(encodeURIComponent(urlFragment)) || frame.includes(urlFragment);
}

/**
 * The below-`lg` gallery serves exactly one photograph, and it is the first trusted one.
 *
 * This is the mobile spec's canonical-first-surface rule read straight out of the served markup:
 * a `?variant=` deep link resolves the *selection* on the server, but it must not open the phone
 * gallery on that variant's photograph. Asserting it here -- rather than only in the browser --
 * is what stops the server quietly reintroducing a variant-addressed opening frame.
 *
 * It replaces an assertion that looked for `product-visual` frames. That markup was the pre-#52
 * vertical image stack, which the swipe gallery removed; a helper still hunting for it would have
 * gone on matching nothing at all, which is a silently passing test rather than a contract.
 */
function assertMobileGalleryOpensOn(body: string, expectedUrlFragment: string, label: string) {
  const frames = [
    ...body.matchAll(/<button\b[^>]*class="pdp-mobile-gallery__image"[\s\S]{0,1600}?<img[^>]*>/g),
  ].map((match) => match[0]);

  assert.equal(frames.length, 1, `${label}: the phone gallery must serve exactly one photograph`);
  assert.ok(
    serves(frames[0]!, expectedUrlFragment),
    `${label}: the phone gallery must open on ${expectedUrlFragment}, got ${frames[0]!.slice(0, 400)}`,
  );
}

/**
 * The `lg+` slide track serves the named photograph.
 *
 * The desktop track renders every trusted image at once and reveals one slide at a time, so what
 * the server owes a deep link is reachability: the variant's own photograph is in the delivered
 * document rather than waiting on a client fetch.
 */
function assertDesktopTrackServes(body: string, expectedUrlFragment: string, label: string) {
  const track = body.match(/<div class="pdp-stage__track[^"]*"[\s\S]*?<\/section>/)?.[0];

  assert.ok(track, `${label}: expected the desktop slide track to render`);
  assert.ok(
    serves(track, expectedUrlFragment),
    `${label}: the slide track must serve ${expectedUrlFragment}`,
  );
}

function assertProductHeroUses(body: string, expectedUrlFragment: string, label: string) {
  // The hero section carries the media stage's own class alongside `product-page-hero` now, so the
  // class attribute is matched by the token rather than by the whole string.
  const hero = body.match(
    /<section\b[^>]*class="[^"]*\bproduct-page-hero\b[^"]*"[^>]*>[\s\S]{0,1600}?<img[^>]*>/,
  )?.[0];

  assert.ok(hero, `${label}: expected the canonical product hero to render`);
  assert.ok(
    hero.includes(encodeURIComponent(expectedUrlFragment)) || hero.includes(expectedUrlFragment),
    `${label}: product hero must use ${expectedUrlFragment}, got ${hero.slice(0, 500)}`,
  );
}

try {
  await cleanupDatabase();

  const product = await prisma.productMirror.create({
    data: {
      pancakeShopId: SHOP_ID,
      pancakeProductId: productId,
      slug,
      name: "U12 Deep Link Product",
      primaryImageUrl: PRIMARY_IMAGE,
      isPresent: true,
      isActive: true,
      syncedAt: new Date(),
    },
  });

  const otherProduct = await prisma.productMirror.create({
    data: {
      pancakeShopId: SHOP_ID,
      pancakeProductId: otherProductId,
      slug: otherSlug,
      name: "U12 Other Product",
      isPresent: true,
      isActive: true,
      syncedAt: new Date(),
    },
  });

  async function seedVariant(
    ownerId: string,
    pancakeVariationId: string,
    size: string,
    price: number,
    options: Readonly<{ stock: number; isActive?: boolean; imageUrl?: string }>,
  ): Promise<string> {
    const variant = await prisma.variantMirror.create({
      data: {
        pancakeVariationId,
        productId: ownerId,
        color: "Đen",
        size,
        pancakeRetailPrice: price,
        pancakeRetailPriceAfterDiscount: price,
        pancakeImageUrls: options.imageUrl ? [options.imageUrl] : undefined,
        isPresent: true,
        isActive: options.isActive ?? true,
        syncedAt: new Date(),
      },
    });
    await prisma.warehouseStock.create({
      data: {
        variantId: variant.id,
        pancakeWarehouseId: `u12-wh-${runId}`,
        quantity: options.stock,
        syncedAt: new Date(),
      },
    });
    return variant.id;
  }

  // Distinct per-variant photography so the gallery assertion can tell them apart.
  mediumVariantMirrorId = await seedVariant(product.id, MEDIUM_VARIATION, "M", MEDIUM_PRICE, {
    stock: 5,
    imageUrl: MEDIUM_IMAGE,
  });
  await seedVariant(product.id, LARGE_VARIATION, "L", LARGE_PRICE, {
    stock: 4,
    imageUrl: LARGE_IMAGE,
  });
  await seedVariant(product.id, SOLD_OUT_VARIATION, "XL", SOLD_OUT_PRICE, { stock: 0 });
  await seedVariant(product.id, INACTIVE_VARIATION, "S", MEDIUM_PRICE, { stock: 6, isActive: false });
  await seedVariant(otherProduct.id, OTHER_PRODUCT_VARIATION, "M", MEDIUM_PRICE, { stock: 3 });

  await startServer({ APP_DOMAIN: OFFICIAL_PRODUCTION_STOREFRONT_HOST, SEARCH_INDEXING_ENABLED: "true" });

  // Baseline: no query means no preselection, which is what every fail-closed case must degrade to.
  const basePage = await requestPath(`/shop/${slug}`);
  assert.equal(basePage.status, 200, `base PDP must render\n${serverOutput}`);
  assertNoChoiceChecked(basePage.body, "base PDP without a variant query");

  const mediumPage = await requestPath(`/shop/${slug}?variant=${MEDIUM_VARIATION}`);
  assert.equal(mediumPage.status, 200, "deep-linked PDP must render");
  assertChoiceChecked(mediumPage.body, "storefront-size", "M", "medium deep link");
  assert.ok(
    mediumPage.body.includes("890.000"),
    `medium deep link must show its own exact price\n${mediumPage.body.slice(0, 3000)}`,
  );

  // A different variation must select itself, proving the resolver matches rather than defaults.
  const largePage = await requestPath(`/shop/${slug}?variant=${LARGE_VARIATION}`);
  assertChoiceChecked(largePage.body, "storefront-size", "L", "large deep link");
  assert.ok(largePage.body.includes("910.000"), "large deep link must show its own exact price");

  for (const [label, query] of [
    ["forged", "u12-pv-forged-does-not-exist"],
    ["another product's variation", OTHER_PRODUCT_VARIATION],
    ["an inactive variation", INACTIVE_VARIATION],
    ["the internal VariantMirror id", mediumVariantMirrorId],
    ["a repeated parameter", `${MEDIUM_VARIATION}&variant=${LARGE_VARIATION}`],
    ["an oversized value", "x".repeat(400)],
    ["an empty value", ""],
  ] as const) {
    const page = await requestPath(`/shop/${slug}?variant=${query}`);
    assert.equal(page.status, 200, `${label} must still render the product page`);
    assertNoChoiceChecked(page.body, `${label} deep link`);
  }

  // A valid current variation that is merely sold out stays addressable and shows its own exact
  // state — price included — rather than falling back to the product's "from" range.
  const soldOutPage = await requestPath(`/shop/${slug}?variant=${SOLD_OUT_VARIATION}`);
  assert.equal(soldOutPage.status, 200, "a sold-out deep link must still render the product page");
  assertChoiceChecked(soldOutPage.body, "storefront-size", "XL", "sold-out deep link");
  assert.ok(
    soldOutPage.body.includes("777.000"),
    `a sold-out deep link must show its own exact price\n${soldOutPage.body.slice(0, 3000)}`,
  );
  assert.ok(
    soldOutPage.body.includes("Hết hàng"),
    "a sold-out deep link must state why it cannot be bought, in the announced status region",
  );

  // The owner-approved PDP contract keeps the first trusted product image as a stable canonical
  // hero. Variant deep links may still bring their own image to the front of the remaining gallery.
  assertProductHeroUses(basePage.body, "u12-primary.jpg", "base PDP without a variant query");
  assertProductHeroUses(mediumPage.body, "u12-primary.jpg", "medium deep link");
  assertProductHeroUses(largePage.body, "u12-primary.jpg", "large deep link");
  // The deep link resolves the selection, not the opening frame: both pages still open on the
  // product's first trusted photograph, and carry the selected variant's own further down.
  assertMobileGalleryOpensOn(basePage.body, "u12-primary.jpg", "base PDP without a variant query");
  assertMobileGalleryOpensOn(mediumPage.body, "u12-primary.jpg", "medium deep link");
  assertMobileGalleryOpensOn(largePage.body, "u12-primary.jpg", "large deep link");
  assertDesktopTrackServes(mediumPage.body, "u12-medium.jpg", "medium deep link");
  assertDesktopTrackServes(largePage.body, "u12-large.jpg", "large deep link");

  // Search contract: the query must not mint a second canonical, and must not become indexable.
  for (const path of [`/shop/${slug}`, `/shop/${slug}?variant=${MEDIUM_VARIATION}`]) {
    const page = await requestPath(path);
    assert.ok(
      page.body.includes(`rel="canonical" href="${PUBLIC_ORIGIN}/shop/${slug}"`),
      `${path} must keep the base PDP canonical`,
    );
    assert.equal(
      page.body.includes(`rel="canonical" href="${PUBLIC_ORIGIN}/shop/${slug}?`),
      false,
      `${path} must not emit a variant-scoped canonical`,
    );
  }

  const indexableBase = await requestPath(`/shop/${slug}`);
  assert.equal(indexableBase.xRobotsTag, null, "base PDP stays indexable while indexing is enabled");

  const deepLinked = await requestPath(`/shop/${slug}?variant=${MEDIUM_VARIATION}`);
  assert.ok(
    (deepLinked.xRobotsTag ?? "").includes("noindex"),
    "the variant query must stay noindex under the existing search-exposure rule",
  );

  console.log(
    "U12 variant deep link HTTP smoke passed: the PDP keeps its canonical primary-image hero while a valid standalone variation preselects its exact option, price and remaining-gallery photo; a sold-out one stays addressable and states why it cannot be bought; forged/foreign/inactive/internal-id/repeated/oversized values all fall back to the base PDP; the base product URL remains the only canonical; and the variant query stays noindex.",
  );
} finally {
  await stopServer();
  await rm(nextDevDirectory, { recursive: true, force: true });
  await cleanupDatabase();
  await prisma.$disconnect();
}
