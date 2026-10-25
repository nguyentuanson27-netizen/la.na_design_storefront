import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import type { ApplicablePromotionCampaign } from "../../src/commerce/promotion-pricing.ts";
import { buildStorefrontCartLines, type StorefrontCartProduct, type StorefrontCartVariant } from "../../src/commerce/storefront-cart.ts";
import { buildCartLineUrgency } from "../../src/commerce/storefront-cart-urgency.ts";
import { buildPromotionalStorefrontPricing } from "../../src/commerce/storefront-promotion-projection.ts";
import { buildCartViewModel } from "../../src/routes/cart-model.ts";

/** The cart line's Flash Sale countdown and "Còn x", decided by the PDP's own rules. */

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const now = new Date("2026-10-25T03:00:00.000Z");
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

function variant(id: string, size: string, sellableStock: number): StorefrontCartVariant {
  return {
    id,
    pancakeVariationId: `pancake-${id}`,
    isPresent: true,
    isActive: true,
    color: "Trắng",
    size,
    sellableStock,
    retailPrice: 1_149_000,
    retailPriceAfterDiscount: 1_149_000,
  };
}

function product(variants: StorefrontCartVariant[], sellingMode: "STANDARD" | "OVERSELL" = "STANDARD"): StorefrontCartProduct {
  return {
    slug: "set-vay-dieu-lien-hoa",
    pancakeProductId: "pancake-set",
    name: "Set váy Diệu Liên Hoa",
    isPresent: true,
    isActive: true,
    sellingPolicy: { sellingMode, negativeStockLimit: sellingMode === "STANDARD" ? 0 : -20 },
    variants,
  };
}

function flash(endsInMs: number): ApplicablePromotionCampaign {
  return {
    id: "flash-1",
    name: "Flash",
    kind: "FLASH_SALE",
    discountType: "FIXED_PRICE",
    percentageValue: null,
    fixedPriceVnd: BigInt(799_000),
    startsAt: new Date(now.getTime() - HOUR),
    endsAt: new Date(now.getTime() + endsInMs),
  };
}

test("a Flash-priced line counts down its own campaign; a line no Flash Sale prices does not", () => {
  const products = [product([variant("v-s", "S", 8), variant("v-m", "M", 8)])];
  const urgency = buildCartLineUrgency({
    items: [{ variantId: "v-s" }, { variantId: "v-m" }],
    products,
    campaignsByVariantId: new Map([["v-s", [flash(2 * HOUR + 13 * MINUTE)]]]),
    now,
  });
  assert.deepEqual(urgency, { "v-s": { flashRemainingMs: 2 * HOUR + 13 * MINUTE } });
});

test('"Còn x" is said for a STANDARD line below the limit, never under OVERSELL', () => {
  const items = [{ variantId: "v-s" }, { variantId: "v-m" }];
  const standard = buildCartLineUrgency({
    items,
    products: [product([variant("v-s", "S", 2), variant("v-m", "M", 9)])],
    campaignsByVariantId: new Map(),
    now,
  });
  assert.deepEqual(standard, { "v-s": { lowStock: 2 } });

  const oversell = buildCartLineUrgency({
    items,
    products: [product([variant("v-s", "S", 2), variant("v-m", "M", 9)], "OVERSELL")],
    campaignsByVariantId: new Map(),
    now,
  });
  assert.deepEqual(oversell, {});
});

test("variants that are not in the cart say nothing", () => {
  const urgency = buildCartLineUrgency({
    items: [{ variantId: "v-m" }],
    products: [product([variant("v-s", "S", 1), variant("v-m", "M", 9)])],
    campaignsByVariantId: new Map([["v-s", [flash(HOUR)]]]),
    now,
  });
  assert.deepEqual(urgency, {});
});

test("the cart view shows the countdown only beside a struck Flash price, and only on a line being bought", () => {
  const products = [product([variant("v-s", "S", 2), variant("v-m", "M", 9), variant("v-l", "L", 1)])];
  const campaignsByVariantId = new Map([["v-s", [flash(HOUR)]]]);
  const items = [
    { variantId: "v-s", quantity: 1 },
    { variantId: "v-m", quantity: 1 },
    { variantId: "v-l", quantity: 3 },
  ];
  const lines = buildStorefrontCartLines({ items, products, pricingRule: buildPromotionalStorefrontPricing({ campaignsByVariantId, now }) });
  const lineUrgency = buildCartLineUrgency({ items, products, campaignsByVariantId, now });
  // The M line is undiscounted: even a stray flash fact must not put a countdown beside a full price.
  const view = buildCartViewModel({
    lines,
    commerceTrackingEnabled: false,
    lineUrgency: { ...lineUrgency, "v-m": { flashRemainingMs: HOUR } },
  });

  const [s, m, l] = view.lines;
  assert.equal(s?.flashRemainingMs, HOUR);
  assert.equal(s?.lowStockText, "Size S chỉ còn 2 sản phẩm");
  assert.equal(m?.flashRemainingMs, undefined);
  assert.equal(m?.lowStockText, undefined);
  // L asks for 3 of 1: not buyable as it stands, so it carries its stock limit instead, not "Còn x".
  assert.equal(l?.available, false);
  assert.equal(l?.lowStockText, undefined);
});

test("without an urgency read the cart view is exactly as before", () => {
  const products = [product([variant("v-s", "S", 2)])];
  const items = [{ variantId: "v-s", quantity: 1 }];
  const lines = buildStorefrontCartLines({ items, products });
  const [line] = buildCartViewModel({ lines, commerceTrackingEnabled: false }).lines;
  assert.equal("flashRemainingMs" in (line ?? {}), false);
  assert.equal("lowStockText" in (line ?? {}), false);
});

test("drawer and cart page render the line urgency from the same resolution as the lines", () => {
  for (const file of ["src/components/brand/cart-drawer.tsx", "src/app/cart/page.tsx"]) {
    assert.match(readFileSync(path.join(REPO_ROOT, file), "utf8"), /<CartLineUrgency [^>]*flashRemainingMs=\{line\.flashRemainingMs\} lowStockText=\{line\.lowStockText\}/, file);
  }
  // No second read: the repository derives urgency inside `resolveCart`, lazily and fail-safe, and the
  // runtime takes it from the quote / lines result instead of resolving the cart again.
  const repository = readFileSync(path.join(REPO_ROOT, "src/commerce/storefront-cart-repository.ts"), "utf8");
  assert.match(repository, /const lineUrgency = \(\) => lineUrgencyFrom\(safeItems, cartProducts, campaignsByVariantId, now\)/);
  assert.match(repository, /return buildCartLineUrgency\([\s\S]*?\} catch \{\s*return Object\.freeze\(\{\}\);/);
  assert.doesNotMatch(repository, /getLineUrgency/);
  const runtime = readFileSync(path.join(REPO_ROOT, "src/commerce/storefront-cart-runtime.ts"), "utf8");
  assert.match(runtime, /lineUrgency: result\.state\.quote\.lineUrgency/);
  assert.match(runtime, /getLinesWithUrgency\(/);
  assert.doesNotMatch(runtime, /getLineUrgency/);
});

test("an ended countdown re-reads the cart once: the drawer its own view, /cart its route", () => {
  const urgency = readFileSync(path.join(REPO_ROOT, "src/components/brand/cart-line-urgency.tsx"), "utf8");
  assert.match(urgency, /if \(!expired \|\| reReadFor\.current === snapshot\) return;/);
  assert.match(urgency, /if \(onExpired\) onExpired\(\);\s*else router\.refresh\(\);/);
  const drawer = readFileSync(path.join(REPO_ROOT, "src/components/brand/cart-drawer.tsx"), "utf8");
  assert.match(drawer, /onExpired=\{reloadForExpiry\}/);
  assert.match(drawer, /if \(expiryReloadRef\.current\) return;/);
});
