import assert from "node:assert/strict";
import test from "node:test";

import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "../../src/generated/prisma/client.ts";
import { readVoucherPreview } from "../../src/commerce/voucher-preview.ts";
import { createVoucherSelectionService } from "../../src/commerce/voucher-selection-service.ts";
import { createVoucherFixtures } from "../support/voucher-fixtures.ts";

/**
 * Review fix (PR #214): the picker's DRAFT preview takes unsaved, unverified input. It must not become a way to read a
 * PRIVATE campaign (its card, price, conditions) by id: only the cart that entered the code may see it.
 */

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required for database smoke tests");

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const SHOP = 940_014;
const P = "vchr-prev-priv";
const f = createVoucherFixtures(prisma, SHOP, P);
const ENV = { LA_VOUCHER_ENABLED: "true" } as const;
const selection = createVoucherSelectionService(prisma, { shopId: SHOP, env: ENV });
const PAST = new Date("2026-10-01T00:00:00.000Z");

async function cleanup() {
  await f.cleanup();
  await prisma.cart.deleteMany({ where: { items: { some: { variant: { product: { pancakeShopId: SHOP } } } } } });
  await prisma.productMirror.deleteMany({ where: { pancakeShopId: SHOP } });
  await prisma.rateLimit.deleteMany({ where: { key: { startsWith: "voucher-code-" } } });
}
test.before(cleanup);
test.after(async () => {
  await cleanup();
  await prisma.$disconnect();
});
test.beforeEach(cleanup);

let sequence = 0;
async function cartOf(price: number, quantity: number) {
  sequence += 1;
  const created = await prisma.productMirror.create({
    data: {
      pancakeShopId: SHOP, pancakeProductId: `${P}-${sequence}`, slug: `${P}-${sequence}`, name: `Preview private ${sequence}`, isActive: true, isPresent: true, syncedAt: PAST,
      variants: { create: { pancakeVariationId: `${P}-${sequence}-var`, color: "Black", size: "M", isActive: true, isPresent: true, pancakeRetailPrice: price, pancakeRetailPriceAfterDiscount: price, syncedAt: PAST,
        warehouseStocks: { create: { pancakeWarehouseId: `${P}-wh-${sequence}`, quantity: 50, syncedAt: PAST } } } },
    },
    include: { variants: true },
  });
  return prisma.cart.create({ data: { expiresAt: new Date(Date.now() + 86_400_000), items: { create: { variantId: created.variants[0]!.id, quantity } } } });
}
const json = (value: unknown) => JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? String(v) : v));
const draft = (merchandiseId: string | null, shippingId: string | null) => ({
  merchandise: merchandiseId === null ? ({ mode: "AUTO" } as const) : ({ mode: "MANUAL", voucherId: merchandiseId } as const),
  shipping: shippingId === null ? ({ mode: "AUTO" } as const) : ({ mode: "MANUAL", voucherId: shippingId } as const),
});
const preview = (cartId: string, selectionOverride?: ReturnType<typeof draft>) =>
  readVoucherPreview({ client: prisma, cartId, shopId: SHOP, now: new Date(), env: ENV, ...(selectionOverride ? { selectionOverride } : {}) });

test("P1 PRIVATE: a draft preview never reveals a PRIVATE campaign to a cart that did not enter its code", async () => {
  const a = await cartOf(450_000, 2);
  const b = await cartOf(450_000, 2);
  const priv = await f.campaign({ name: "SECRET-KOL-MERCH", issuance: "CODE", visibility: "PRIVATE", code: "KOL50", fixedAmountVnd: BigInt(50_000), minEligibleSubtotalVnd: BigInt(600_000) });
  const privShip = await f.shippingCampaign({ name: "SECRET-KOL-SHIP", issuance: "CODE", visibility: "PRIVATE", code: "SHIPKOL", minEligibleSubtotalVnd: BigInt(600_000) });
  assert.equal((await selection.applyCode({ cartId: a.id, rawCode: "KOL50" })).ok, true);

  // Cart B knows the ids and posts them as a draft, in each group and together. The only thing that may come back
  // is B's own input echoed in a notice, and the answer must be indistinguishable from an id that does not exist.
  const ghost = async (override: ReturnType<typeof draft>, replace: readonly [string, string][]) => {
    let text = json(await preview(b.id, override));
    for (const [from, to] of replace) text = text.replaceAll(from, to);
    return text;
  };
  const cases: Array<[ReturnType<typeof draft>, ReturnType<typeof draft>, readonly [string, string][]]> = [
    [draft(priv.id, null), draft("ghost-m", null), [[priv.id, "ID"], ["ghost-m", "ID"]]],
    [draft(null, privShip.id), draft(null, "ghost-s"), [[privShip.id, "ID"], ["ghost-s", "ID"]]],
    [draft(priv.id, privShip.id), draft("ghost-m", "ghost-s"), [[priv.id, "M"], [privShip.id, "S"], ["ghost-m", "M"], ["ghost-s", "S"]]],
  ];
  for (const [private_, absent, replace] of cases) {
    const text = await ghost(private_, replace);
    assert.doesNotMatch(text, /SECRET-KOL/, "no name of a private campaign");
    assert.doesNotMatch(text, /(?<![0-9])(850000|50000|880000)(?![0-9])/, "no private price or total");
    assert.equal(text, await ghost(absent, replace), "the same answer as for an id that does not exist");
  }
  const b1 = await preview(b.id, draft(priv.id, null));
  assert.ok(b1.enabled && b1.ok);
  assert.equal(b1.quote.merchandiseDiscountVnd, 0, "the private voucher takes no part in B's quote");

  // Nothing was saved for B, and A (which unlocked the code) still previews its own voucher.
  assert.equal(await prisma.cartVoucherSelection.count({ where: { cartId: b.id } }), 0);
  const a1 = await preview(a.id, draft(priv.id, null));
  assert.ok(a1.enabled && a1.ok);
  assert.equal(a1.quote.merchandiseDiscountVnd, 50_000);
  assert.ok(json(a1.entries).includes(priv.id));
});

test("P1 PRIVATE: PUBLIC drafts are unaffected and a draft cannot unlock what the saved selection does not name", async () => {
  const a = await cartOf(450_000, 2);
  const pub = await f.campaign({ name: "PUBLIC-OFFER", fixedAmountVnd: BigInt(30_000), minEligibleSubtotalVnd: BigInt(600_000) });
  const priv = await f.campaign({ name: "SECRET-KOL-MERCH", issuance: "CODE", visibility: "PRIVATE", code: "KOL50", fixedAmountVnd: BigInt(50_000), minEligibleSubtotalVnd: BigInt(600_000) });
  const withPublic = await preview(a.id, draft(pub.id, null));
  assert.ok(withPublic.enabled && withPublic.ok);
  assert.equal(withPublic.quote.merchandiseDiscountVnd, 30_000);
  // A never entered KOL50: a draft naming it sees nothing of it.
  const named = await preview(a.id, draft(priv.id, null));
  assert.doesNotMatch(json(named), /SECRET-KOL/);
  // After the code is entered, the same draft is allowed.
  assert.equal((await selection.applyCode({ cartId: a.id, rawCode: "KOL50" })).ok, true);
  const unlocked = await preview(a.id, draft(priv.id, null));
  assert.ok(unlocked.enabled && unlocked.ok);
  assert.equal(unlocked.quote.merchandiseDiscountVnd, 50_000);
});
