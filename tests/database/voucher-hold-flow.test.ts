import assert from "node:assert/strict";
import test from "node:test";

import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "../../src/generated/prisma/client.ts";
import { createVoucherHoldFlow, type VoucherHoldFlowResult } from "../../src/commerce/voucher-hold-flow.ts";
import { readVoucherPreview } from "../../src/commerce/voucher-preview.ts";
import { issueVoucherQuoteProof, verifyVoucherQuoteProof, voucherProofFactsFromQuote, type VoucherProofLine } from "../../src/commerce/voucher-quote-proof.ts";
import { applyAllocationToLines } from "../../src/commerce/voucher-quote.ts";
import { createVoucherSelectionService } from "../../src/commerce/voucher-selection-service.ts";
import { createVoucherFixtures } from "../support/voucher-fixtures.ts";

/**
 * V12 against a real database and the real cart/tier/gift/shipping engines: the one POST that turns a preview
 * into a held quote. Gates, exact-money check, expected-total agreement, atomic hold, HELD proof (ADR 0019).
 */

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required for database smoke tests");

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const SHOP = 940_008;
const P = "vchr-flow";
const SECRET = "voucher-flow-test-secret-0123456789abcdef";
const f = createVoucherFixtures(prisma, SHOP, P);
const PAST = new Date("2026-10-01T00:00:00.000Z");
const ENV = { LA_VOUCHER_ENABLED: "true", LA_PANCAKE_VOUCHER_VERIFIED_SHOP_IDS: String(SHOP) } as const;
const flow = createVoucherHoldFlow(prisma, { shopId: SHOP, attemptSecret: SECRET, proofSecret: SECRET, env: ENV });

async function cleanup() {
  await f.cleanup();
  await prisma.cart.deleteMany({ where: { items: { some: { variant: { product: { pancakeShopId: SHOP } } } } } });
  await prisma.shippingPromotionCampaign.deleteMany({ where: { pancakeShopId: SHOP } });
  await prisma.productMirror.deleteMany({ where: { pancakeShopId: SHOP } });
}
let sequence = 0;
async function product(price: number, stock = 50) {
  sequence += 1;
  const created = await prisma.productMirror.create({
    data: {
      pancakeShopId: SHOP, pancakeProductId: `${P}-${sequence}`, slug: `${P}-${sequence}`, name: `Voucher flow ${sequence}`, isActive: true, isPresent: true, syncedAt: PAST,
      variants: { create: { pancakeVariationId: `${P}-${sequence}-var`, color: "Black", size: "M", isActive: true, isPresent: true, pancakeRetailPrice: price, pancakeRetailPriceAfterDiscount: price, syncedAt: PAST,
        warehouseStocks: { create: { pancakeWarehouseId: `${P}-wh-${sequence}`, quantity: stock, syncedAt: PAST } } } },
    },
    include: { variants: true },
  });
  return created.variants[0]!.id;
}
const cart = (items: ReadonlyArray<{ variantId: string; quantity: number }>) =>
  prisma.cart.create({ data: { expiresAt: new Date(Date.now() + 86_400_000), items: { create: items.map((i) => ({ variantId: i.variantId, quantity: i.quantity })) } } });
const fixed = (amountVnd: number, min: number, extra: Record<string, unknown> = {}) => f.campaign({ fixedAmountVnd: BigInt(amountVnd), minEligibleSubtotalVnd: BigInt(min), ...extra });
const holdsOf = () => prisma.voucherHold.findMany({ where: { campaign: { pancakeShopId: SHOP } }, orderBy: { createdAt: "asc" } });
const held = (r: VoucherHoldFlowResult) => {
  assert.equal(r.ok && r.state === "HELD", true, JSON.stringify(r));
  return r as Extract<VoucherHoldFlowResult, { ok: true; state: "HELD" }>;
};

test.before(cleanup);
test.after(async () => {
  await cleanup();
  await prisma.$disconnect();
});
test.beforeEach(cleanup);

/** Recomputes the held facts independently of the flow, the way a submit would. */
async function recomputedFacts(cartId: string, result: Extract<VoucherHoldFlowResult, { ok: true; state: "HELD" }>) {
  const preview = await readVoucherPreview({ client: prisma, cartId, shopId: SHOP, now: new Date(), env: ENV });
  assert.ok(preview.enabled && preview.ok);
  if (!preview.enabled || !preview.ok) throw new Error("unreachable");
  const variation = preview.variationOfLine;
  const lines: VoucherProofLine[] = applyAllocationToLines(preview.lines, preview.quote.allocation).map((l) => ({
    pancakeVariationId: variation.get(l.lineId.replace(/\|v\d+$/, ""))!, quantity: l.quantity, unitPriceVnd: l.unitPriceVnd, role: "PAID",
  }));
  const at = (kind: string) => result.holds.find((h) => h.kind === kind);
  const bind = (kind: string) => (at(kind) ? { holdId: at(kind)!.holdId, expiresAtMs: at(kind)!.expiresAtMs } : undefined);
  const m = bind("MERCHANDISE");
  const s = bind("SHIPPING_FREE");
  return voucherProofFactsFromQuote({ quote: preview.quote, campaigns: preview.campaigns, paidRevision: preview.paidRevision, lines, holds: { ...(m ? { merchandise: m } : {}), ...(s ? { shipping: s } : {}) } });
}

test("D-6: feature off or shop not verified answers PREVIEW_ONLY and reads and writes nothing", async () => {
  const c = await cart([{ variantId: await product(450_000), quantity: 2 }]);
  await fixed(50_000, 100_000);
  const off = createVoucherHoldFlow(prisma, { shopId: SHOP, attemptSecret: SECRET, proofSecret: SECRET, env: {} });
  const unverified = createVoucherHoldFlow(prisma, { shopId: SHOP, attemptSecret: SECRET, proofSecret: SECRET, env: { LA_VOUCHER_ENABLED: "true" } });
  assert.deepEqual(await off.hold({ cartId: c.id, expectedTotalVnd: 850_000 }), { ok: false, reason: "PREVIEW_ONLY" });
  assert.deepEqual(await unverified.hold({ cartId: c.id, expectedTotalVnd: 850_000 }), { ok: false, reason: "PREVIEW_ONLY" });
  assert.equal((await holdsOf()).length, 0);
});

test("AC-43 / EX-01: the POST holds both vouchers once, returns a HELD proof a submit can verify, and a PREVIEW proof can never submit", async () => {
  const c = await cart([{ variantId: await product(450_000), quantity: 2 }]);
  const m = await fixed(50_000, 600_000);
  const s = await f.shippingCampaign({ minEligibleSubtotalVnd: BigInt(600_000) });
  const result = held(await flow.hold({ cartId: c.id, expectedTotalVnd: 850_000 }));
  assert.equal(result.totalPayableVnd, 850_000);
  assert.deepEqual(result.holds.map((h) => [h.kind, h.campaignId, h.amountVnd, h.reused]), [["MERCHANDISE", m.id, 50_000, false], ["SHIPPING_FREE", s.id, 30_000, false]]);
  assert.equal(result.expiresAtMs, Math.min(...result.holds.map((h) => h.expiresAtMs)));
  assert.equal((await holdsOf()).length, 2);
  assert.equal((await prisma.voucherCampaign.findUniqueOrThrow({ where: { id: m.id } })).reservedUses, 1);

  const facts = await recomputedFacts(c.id, result);
  const now = new Date();
  assert.deepEqual(verifyVoucherQuoteProof({ proof: result.proof, cartId: c.id, current: facts, secret: SECRET, mode: "SUBMIT", now }), { ok: true, held: true });
  assert.deepEqual(verifyVoucherQuoteProof({ proof: result.proof, cartId: c.id, current: facts, secret: SECRET, mode: "SUBMIT", now: new Date(result.expiresAtMs) }), { ok: false, reason: "HOLD_EXPIRED" });
  assert.equal(verifyVoucherQuoteProof({ proof: result.proof, cartId: "another-cart", current: facts, secret: SECRET, mode: "SUBMIT", now }).ok, false, "bound to this cart");
  const previewOnly = issueVoucherQuoteProof({ facts: { ...facts, state: "PREVIEW", merchandise: { ...facts.merchandise!, hold: null }, shipping: { ...facts.shipping!, hold: null } }, cartId: c.id, secret: SECRET })!;
  assert.deepEqual(verifyVoucherQuoteProof({ proof: previewOnly, cartId: c.id, current: { ...facts, state: "PREVIEW", merchandise: { ...facts.merchandise!, hold: null }, shipping: { ...facts.shipping!, hold: null } }, secret: SECRET, mode: "SUBMIT", now }), { ok: false, reason: "HOLD_REQUIRED" });
});

test("AC-43: repeating the POST (reload, double click, two tabs) is idempotent: same holds, same expiry, same proof, one ledger entry", async () => {
  const c = await cart([{ variantId: await product(450_000), quantity: 2 }]);
  const m = await fixed(50_000, 600_000, { maxUses: 3 });
  const first = held(await flow.hold({ cartId: c.id, expectedTotalVnd: 880_000 }));
  await new Promise((resolve) => setTimeout(resolve, 30));
  const [again, parallel] = (await Promise.all([flow.hold({ cartId: c.id, expectedTotalVnd: 880_000 }), flow.hold({ cartId: c.id, expectedTotalVnd: 880_000 })])).map(held);
  for (const r of [again, parallel]) {
    assert.deepEqual(r.holds.map((h) => [h.holdId, h.expiresAtMs, h.reused]), first.holds.map((h) => [h.holdId, h.expiresAtMs, true]));
    assert.equal(r.proof, first.proof);
  }
  assert.equal((await holdsOf()).length, 1);
  assert.equal((await prisma.voucherCampaign.findUniqueOrThrow({ where: { id: m.id } })).reservedUses, 1);
});

test("AC-34: a total the buyer did not see is TOTAL_CHANGED and nothing is held", async () => {
  const c = await cart([{ variantId: await product(450_000), quantity: 2 }]);
  await fixed(50_000, 600_000);
  assert.deepEqual(await flow.hold({ cartId: c.id, expectedTotalVnd: 900_000 }), { ok: false, reason: "TOTAL_CHANGED", currentTotalVnd: 880_000 });
  assert.equal((await holdsOf()).length, 0);
});

test("AC-20: even when the preview thought it fine, money the POS cannot take leaves no hold, no budget and no proof", async () => {
  const c = await cart([{ variantId: await product(450_000), quantity: 2 }]);
  const m = await fixed(50_000, 600_000, { maxUses: 3 });
  const real = await readVoucherPreview({ client: prisma, cartId: c.id, shopId: SHOP, now: new Date(), env: ENV });
  assert.ok(real.enabled && real.ok);
  if (!real.enabled || !real.ok) return;
  // 99.999 gift slots cannot be carved out of two paid units: the vendor projection must refuse the whole cart.
  const poisoned = { ...real, quote: { ...real.quote, gifts: { ...real.quote.gifts, retainedSelectedSlots: 99_999 } } };
  const guarded = createVoucherHoldFlow(prisma, { shopId: SHOP, attemptSecret: SECRET, proofSecret: SECRET, env: ENV, readPreview: async () => poisoned });
  assert.deepEqual(await guarded.hold({ cartId: c.id, expectedTotalVnd: real.quote.totalPayableVnd }), { ok: false, reason: "POS_INFEASIBLE" });
  assert.equal((await holdsOf()).length, 0);
  const row = await prisma.voucherCampaign.findUniqueOrThrow({ where: { id: m.id } });
  assert.deepEqual([row.reservedUses, row.reservedVnd], [0, BigInt(0)]);
});

test("a swap on a changed quote releases the old hold and holds the new one; choosing NONE releases everything", async () => {
  const c = await cart([{ variantId: await product(450_000), quantity: 2 }]);
  const small = await fixed(10_000, 100_000, { name: "small", maxUses: 5 });
  const big = await fixed(80_000, 100_000, { name: "big", maxUses: 5 });
  const selection = createVoucherSelectionService(prisma, { shopId: SHOP, env: ENV });
  const first = held(await flow.hold({ cartId: c.id, expectedTotalVnd: 900_000 - 80_000 + 30_000 }));
  assert.equal(first.holds[0]!.campaignId, big.id);
  await selection.setGroup({ cartId: c.id, group: "MERCHANDISE", mode: "MANUAL", voucherId: small.id });
  const swapped = held(await flow.hold({ cartId: c.id, expectedTotalVnd: 900_000 - 10_000 + 30_000 }));
  assert.equal(swapped.holds[0]!.campaignId, small.id);
  assert.deepEqual((await holdsOf()).map((h) => h.state), ["RELEASED", "HELD"]);
  assert.equal((await prisma.voucherCampaign.findUniqueOrThrow({ where: { id: big.id } })).reservedUses, 0);
  await selection.setGroup({ cartId: c.id, group: "MERCHANDISE", mode: "MANUAL", voucherId: null });
  const none = await flow.hold({ cartId: c.id, expectedTotalVnd: 930_000 });
  assert.deepEqual(none.ok && none.state === "NONE" && none.released, ["MERCHANDISE"]);
  assert.equal((await prisma.voucherCampaign.findUniqueOrThrow({ where: { id: small.id } })).reservedUses, 0);
});

test("a cart whose paid lines moved after the preview is CART_CHANGED, and a voucher taken by someone else meanwhile is CAPACITY_EXHAUSTED; neither leaves a hold", async () => {
  const variantId = await product(450_000);
  const a = await cart([{ variantId, quantity: 2 }]);
  const b = await cart([{ variantId, quantity: 2 }]);
  await fixed(50_000, 600_000, { maxUses: 1 });

  // The preview b will act on is read first; then a takes the only use.
  const stalePreview = await readVoucherPreview({ client: prisma, cartId: b.id, shopId: SHOP, now: new Date(), env: ENV });
  held(await flow.hold({ cartId: a.id, expectedTotalVnd: 880_000 }));
  const staleFlow = createVoucherHoldFlow(prisma, { shopId: SHOP, attemptSecret: SECRET, proofSecret: SECRET, env: ENV, readPreview: async () => stalePreview });
  const total = stalePreview.enabled && stalePreview.ok ? stalePreview.quote.totalPayableVnd : -1;
  assert.deepEqual(await staleFlow.hold({ cartId: b.id, expectedTotalVnd: total }), { ok: false, reason: "CAPACITY_EXHAUSTED" });

  // Cart b changes after its preview was read (a paid line is added): the hold refuses the stale revision.
  await prisma.cartItem.create({ data: { cartId: b.id, variantId: await product(100_000), quantity: 1 } });
  const moved = await staleFlow.hold({ cartId: b.id, expectedTotalVnd: total });
  assert.deepEqual(moved, { ok: false, reason: "CART_CHANGED" });
  assert.equal((await holdsOf()).filter((h) => h.state === "HELD").length, 1, "only cart a holds");
});

test("D-5: the hold POST is throttled per cart and the throttle is not the code throttle; the limit refuses before any read", async () => {
  const c = await cart([{ variantId: await product(450_000), quantity: 2 }]);
  await fixed(50_000, 600_000, { maxUses: 3 });
  const allowed = [true, true, false];
  const seen: string[] = [];
  const limited = createVoucherHoldFlow(prisma, {
    shopId: SHOP, attemptSecret: SECRET, proofSecret: SECRET, env: ENV,
    rateLimiter: { consume: async ({ cartId }) => { seen.push(cartId); return allowed.shift() ?? false; } },
    readPreview: async (input) => { seen.push("read"); return readVoucherPreview(input); },
  });
  held(await limited.hold({ cartId: c.id, expectedTotalVnd: 880_000 }));
  held(await limited.hold({ cartId: c.id, expectedTotalVnd: 880_000 }));
  assert.deepEqual(await limited.hold({ cartId: c.id, expectedTotalVnd: 880_000 }), { ok: false, reason: "RATE_LIMITED" });
  assert.deepEqual(seen, [c.id, "read", c.id, "read", c.id], "the refused attempt never reached the preview read");
  assert.equal((await holdsOf()).length, 1);
});

test("the real hold limiter admits a normal reload burst and refuses a flood, with keys apart from the code limiter", async () => {
  const { createVoucherHoldRateLimiter, createVoucherCodeRateLimiter } = await import("../../src/commerce/voucher-code-rate-limit.ts");
  const hold = createVoucherHoldRateLimiter(prisma);
  const code = createVoucherCodeRateLimiter(prisma);
  const input = { cartId: `${P}-limiter-${process.pid}`, shopId: SHOP, now: new Date() };
  const results: boolean[] = [];
  for (let i = 0; i < 22; i += 1) results.push(await hold.consume(input));
  assert.deepEqual([results.slice(0, 20).every(Boolean), results[20], results[21]], [true, false, false]);
  assert.equal(await code.consume(input), true, "spending the hold budget did not touch the code budget");
  await prisma.$executeRaw`DELETE FROM "rateLimit" WHERE "key" LIKE 'voucher-hold-%' OR "key" LIKE 'voucher-code-%'`;
});
