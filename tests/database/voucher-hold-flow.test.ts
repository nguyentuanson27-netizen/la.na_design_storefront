import assert from "node:assert/strict";
import test from "node:test";

import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "../../src/generated/prisma/client.ts";
import { createVoucherHoldFlow, type VoucherHoldFlowResult } from "../../src/commerce/voucher-hold-flow.ts";
import { createVoucherHoldService } from "../../src/commerce/voucher-hold-service.ts";
import { buildVoucherQuoteFacts } from "../../src/commerce/voucher-quote-facts.ts";
import { buildVoucherPickerModel } from "../../src/routes/voucher-picker-model.ts";
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
const MIN = 60_000;
const ENV = { LA_VOUCHER_ENABLED: "true", LA_PANCAKE_VOUCHER_VERIFIED_SHOP_IDS: String(SHOP) } as const;
const flow = createVoucherHoldFlow(prisma, { shopId: SHOP, attemptSecret: SECRET, proofSecret: SECRET, env: ENV });
const service = createVoucherHoldService(prisma, { attemptSecret: SECRET, env: ENV });

/** What the picker would show this cart right now (own live holds kept in play), with its digest. */
async function shown(cartId: string) {
  const preview = await readVoucherPreview({ client: prisma, cartId, shopId: SHOP, now: new Date(), env: ENV, ownHolds: await service.readOwnLiveHolds(cartId) });
  assert.ok(preview.enabled && preview.ok, JSON.stringify(preview, (_k, v) => (typeof v === "bigint" ? String(v) : v)));
  if (!preview.enabled || !preview.ok) throw new Error("unreachable");
  return preview;
}
/** The buyer clicks: sends the digest of what they were shown. */
async function click(cartId: string, extra: { acknowledged?: boolean } = {}, using = flow) {
  return using.hold({ cartId, expectedQuoteDigest: (await shown(cartId)).quoteDigest!, ...extra });
}

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
  const preview = await shown(cartId);
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
  const digest = (await shown(c.id)).quoteDigest!;
  const off = createVoucherHoldFlow(prisma, { shopId: SHOP, attemptSecret: SECRET, proofSecret: SECRET, env: {} });
  const unverified = createVoucherHoldFlow(prisma, { shopId: SHOP, attemptSecret: SECRET, proofSecret: SECRET, env: { LA_VOUCHER_ENABLED: "true" } });
  assert.deepEqual(await off.hold({ cartId: c.id, expectedQuoteDigest: digest }), { ok: false, reason: "PREVIEW_ONLY" });
  assert.deepEqual(await unverified.hold({ cartId: c.id, expectedQuoteDigest: digest }), { ok: false, reason: "PREVIEW_ONLY" });
  assert.equal((await holdsOf()).length, 0);
});

test("AC-43 / EX-01: the POST holds both vouchers once, returns a HELD proof a submit can verify, and a PREVIEW proof can never submit", async () => {
  const c = await cart([{ variantId: await product(450_000), quantity: 2 }]);
  const m = await fixed(50_000, 600_000);
  const s = await f.shippingCampaign({ minEligibleSubtotalVnd: BigInt(600_000) });
  const picker = buildVoucherPickerModel({ quote: (await shown(c.id)).quote, entries: (await shown(c.id)).entries, quoteDigest: (await shown(c.id)).quoteDigest });
  assert.match(picker.quoteDigest ?? "", /^[0-9a-f]{64}$/, "the picker shows the digest the POST will be checked against");
  const result = held(await click(c.id));
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
  const unheld = { ...facts, state: "PREVIEW" as const, merchandise: { ...facts.merchandise!, hold: null }, shipping: { ...facts.shipping!, hold: null } };
  const previewOnly = issueVoucherQuoteProof({ facts: unheld, cartId: c.id, secret: SECRET })!;
  assert.deepEqual(verifyVoucherQuoteProof({ proof: previewOnly, cartId: c.id, current: unheld, secret: SECRET, mode: "SUBMIT", now }), { ok: false, reason: "HOLD_REQUIRED" });
});

test("AC-43: repeating the POST (reload, double click, two tabs) is idempotent: same holds, same expiry, same proof, one ledger entry", async () => {
  const c = await cart([{ variantId: await product(450_000), quantity: 2 }]);
  const m = await fixed(50_000, 600_000, { maxUses: 3 });
  const first = held(await click(c.id));
  await new Promise((resolve) => setTimeout(resolve, 30));
  const [again, parallel] = (await Promise.all([click(c.id), click(c.id)])).map(held);
  for (const r of [again, parallel]) {
    assert.deepEqual(r.holds.map((h) => [h.holdId, h.expiresAtMs, h.reused]), first.holds.map((h) => [h.holdId, h.expiresAtMs, true]));
    assert.equal(r.proof, first.proof);
  }
  assert.equal((await holdsOf()).length, 1);
  assert.equal((await prisma.voucherCampaign.findUniqueOrThrow({ where: { id: m.id } })).reservedUses, 1);
});

test("P1 self-held: with quota = 1 the buyer's own retry keeps the SAME hold, expiry, counters and proof (it is not released)", async () => {
  const c = await cart([{ variantId: await product(450_000), quantity: 2 }]);
  const m = await fixed(50_000, 600_000, { maxUses: 1 });
  const first = held(await click(c.id));
  await new Promise((resolve) => setTimeout(resolve, 30));
  const again = held(await click(c.id));
  assert.deepEqual(again.holds.map((h) => [h.holdId, h.expiresAtMs, h.reused]), first.holds.map((h) => [h.holdId, h.expiresAtMs, true]));
  assert.equal(again.proof, first.proof);
  const row = await prisma.voucherCampaign.findUniqueOrThrow({ where: { id: m.id } });
  assert.deepEqual([row.reservedUses, row.reservedVnd], [1, BigInt(50_000)]);
  assert.deepEqual((await holdsOf()).map((h) => h.state), ["HELD"]);
  // Another buyer still cannot take the only use.
  const other = await cart([{ variantId: (await prisma.variantMirror.findFirstOrThrow({ where: { product: { pancakeShopId: SHOP } } })).id, quantity: 2 }]);
  assert.equal((await shown(other.id)).quote.voucherCount, 0);
});

test("P1 TG-05 A / AC-31: a campaign that ended (or was switched off) at T+3 still honours the held entitlement on a retry at T+5", async () => {
  for (const change of [{ endsAt: new Date(Date.now() - 2 * MIN), startsAt: new Date(Date.now() - 60 * MIN) }, { isEnabled: false, disabledAt: new Date() }]) {
    await cleanup();
    const c = await cart([{ variantId: await product(450_000), quantity: 2 }]);
    const m = await fixed(50_000, 600_000, { maxUses: 1 });
    const first = held(await click(c.id));
    await prisma.voucherCampaign.update({ where: { id: m.id }, data: change });
    const again = held(await click(c.id));
    assert.deepEqual(again.holds.map((h) => [h.holdId, h.expiresAtMs, h.reused]), first.holds.map((h) => [h.holdId, h.expiresAtMs, true]), JSON.stringify(change));
    assert.equal(again.proof, first.proof);
    assert.equal((await prisma.voucherCampaign.findUniqueOrThrow({ where: { id: m.id } })).reservedUses, 1);
    // ...but nothing new is granted from it to someone else.
    const stranger = await cart([{ variantId: (await prisma.variantMirror.findFirstOrThrow({ where: { product: { pancakeShopId: SHOP } } })).id, quantity: 2 }]);
    assert.equal((await shown(stranger.id)).quote.voucherCount, 0);
  }
});

test("P1: an edited campaign (new revision) is NOT the held entitlement: the hold swaps to the new terms, it is not silently reused", async () => {
  const c = await cart([{ variantId: await product(450_000), quantity: 2 }]);
  const m = await fixed(50_000, 600_000, { maxUses: 1 });
  const first = held(await click(c.id));
  await prisma.voucherCampaign.update({ where: { id: m.id }, data: { fixedAmountVnd: BigInt(40_000), revision: { increment: 1 } } });
  const swapped = held(await click(c.id));
  assert.notEqual(swapped.holds[0]!.holdId, first.holds[0]!.holdId);
  assert.equal(swapped.holds[0]!.amountVnd, 40_000);
  assert.deepEqual((await holdsOf()).map((h) => h.state), ["RELEASED", "HELD"]);
  const row = await prisma.voucherCampaign.findUniqueOrThrow({ where: { id: m.id } });
  assert.deepEqual([row.reservedUses, row.reservedVnd], [1, BigInt(40_000)]);
});

test("P1 consent: a quote that changed answers QUOTE_CHANGED even when the TOTAL is equal; two different vouchers of the same value are different quotes", async () => {
  const c = await cart([{ variantId: await product(450_000), quantity: 2 }]);
  const a = await fixed(50_000, 100_000, { name: "A" });
  const b = await fixed(50_000, 100_000, { name: "B" });
  const selection = createVoucherSelectionService(prisma, { shopId: SHOP, env: ENV });
  await selection.setGroup({ cartId: c.id, group: "MERCHANDISE", mode: "MANUAL", voucherId: a.id });
  const seen = await shown(c.id);
  assert.equal(seen.quote.selection.merchandiseId, a.id);
  // Another tab switches the cart to B: same discount, same total, different voucher.
  await selection.setGroup({ cartId: c.id, group: "MERCHANDISE", mode: "MANUAL", voucherId: b.id });
  const now = await shown(c.id);
  assert.equal(now.quote.totalPayableVnd, seen.quote.totalPayableVnd, "the totals are equal on purpose");
  assert.notEqual(now.quoteDigest, seen.quoteDigest);
  const refused = await flow.hold({ cartId: c.id, expectedQuoteDigest: seen.quoteDigest! });
  assert.deepEqual(refused, { ok: false, reason: "QUOTE_CHANGED", currentTotalVnd: now.quote.totalPayableVnd, currentQuoteDigest: now.quoteDigest });
  assert.equal((await holdsOf()).length, 0);
  assert.equal(held(await flow.hold({ cartId: c.id, expectedQuoteDigest: now.quoteDigest! })).holds[0]!.campaignId, b.id);
});

test("P1 consent: a quote that costs a gift or raises the total needs an explicit acknowledgement; equal totals are not consent", async () => {
  const c = await cart([{ variantId: await product(450_000), quantity: 2 }]);
  const m = await fixed(50_000, 600_000, { maxUses: 3 });
  const real = await shown(c.id);
  for (const cost of [
    { giftLoss: { entitledSlotsLost: 1, selectedSlotsLost: 1 }, confirmation: null },
    { giftLoss: null, confirmation: { totalIncreaseVnd: 30_000, shippingFeeIncreaseVnd: 30_000 } },
  ]) {
    await cleanup();
    const c2 = await cart([{ variantId: await product(450_000), quantity: 2 }]);
    const m2 = await fixed(50_000, 600_000, { maxUses: 3 });
    const real2 = await shown(c2.id);
    const costly = { ...real2, quote: { ...real2.quote, ...cost } };
    const costlyFlow = createVoucherHoldFlow(prisma, { shopId: SHOP, attemptSecret: SECRET, proofSecret: SECRET, env: ENV, readPreview: async () => costly });
    const digest = real2.quoteDigest!;
    const refused = await costlyFlow.hold({ cartId: c2.id, expectedQuoteDigest: digest });
    assert.equal(!refused.ok && refused.reason, "CONFIRMATION_REQUIRED");
    assert.deepEqual(!refused.ok && refused.confirmation, { giftSlotsLost: cost.giftLoss?.selectedSlotsLost ?? 0, totalIncreaseVnd: cost.confirmation?.totalIncreaseVnd ?? 0, shippingFeeIncreaseVnd: cost.confirmation?.shippingFeeIncreaseVnd ?? 0 });
    assert.equal((await holdsOf()).length, 0, "no hold without consent");
    assert.equal((await prisma.voucherCampaign.findUniqueOrThrow({ where: { id: m2.id } })).reservedUses, 0);
    held(await costlyFlow.hold({ cartId: c2.id, expectedQuoteDigest: digest, acknowledged: true }));
    assert.equal((await holdsOf()).length, 1);
  }
  assert.ok(real && m);
});

test("P1 proof: if the HELD proof cannot be issued the whole call rolls back (no quota held), and a swap keeps its old hold", async () => {
  const c = await cart([{ variantId: await product(450_000), quantity: 2 }]);
  const small = await fixed(10_000, 100_000, { name: "small", maxUses: 5 });
  const big = await fixed(80_000, 100_000, { name: "big", maxUses: 5 });
  const noProof = createVoucherHoldFlow(prisma, { shopId: SHOP, attemptSecret: SECRET, proofSecret: SECRET, env: ENV, issueProof: () => null });
  const throwing = createVoucherHoldFlow(prisma, { shopId: SHOP, attemptSecret: SECRET, proofSecret: SECRET, env: ENV, issueProof: () => { throw new Error("boom"); } });

  for (const failing of [noProof, throwing]) {
    assert.deepEqual(await click(c.id, {}, failing), { ok: false, reason: "PROOF_UNAVAILABLE" });
    assert.equal((await holdsOf()).length, 0);
    for (const id of [small.id, big.id]) assert.deepEqual((({ reservedUses, reservedVnd }) => [reservedUses, reservedVnd])(await prisma.voucherCampaign.findUniqueOrThrow({ where: { id } })), [0, BigInt(0)]);
  }

  const first = held(await click(c.id));
  assert.equal(first.holds[0]!.campaignId, big.id);
  await createVoucherSelectionService(prisma, { shopId: SHOP, env: ENV }).setGroup({ cartId: c.id, group: "MERCHANDISE", mode: "MANUAL", voucherId: small.id });
  assert.deepEqual(await click(c.id, {}, noProof), { ok: false, reason: "PROOF_UNAVAILABLE" });
  const live = await holdsOf();
  assert.deepEqual(live.map((h) => [h.id, h.state]), [[first.holds[0]!.holdId, "HELD"]], "the old hold survives, untouched");
  assert.deepEqual((({ reservedUses, reservedVnd }) => [reservedUses, reservedVnd])(await prisma.voucherCampaign.findUniqueOrThrow({ where: { id: big.id } })), [1, BigInt(80_000)]);
  assert.equal((await prisma.voucherCampaign.findUniqueOrThrow({ where: { id: small.id } })).reservedUses, 0);
});

test("AC-34: a quote the buyer did not see is QUOTE_CHANGED and nothing is held", async () => {
  const c = await cart([{ variantId: await product(450_000), quantity: 2 }]);
  await fixed(50_000, 600_000);
  const result = await flow.hold({ cartId: c.id, expectedQuoteDigest: "0".repeat(64) });
  assert.equal(!result.ok && result.reason, "QUOTE_CHANGED");
  assert.equal(!result.ok && result.currentTotalVnd, 880_000);
  assert.equal((await holdsOf()).length, 0);
  assert.deepEqual(await flow.hold({ cartId: c.id, expectedQuoteDigest: "nope" }), { ok: false, reason: "CART_UNAVAILABLE" });
});

test("AC-20: even when the preview thought it fine, money the POS cannot take leaves no hold, no budget and no proof", async () => {
  const c = await cart([{ variantId: await product(450_000), quantity: 2 }]);
  const m = await fixed(50_000, 600_000, { maxUses: 3 });
  const real = await shown(c.id);
  // 99.999 gift slots cannot be carved out of two paid units: the vendor projection must refuse the whole cart.
  const poisoned = { ...real, quote: { ...real.quote, gifts: { ...real.quote.gifts, retainedSelectedSlots: 99_999 } } };
  const digest = buildVoucherQuoteFacts({ quote: poisoned.quote, campaigns: poisoned.campaigns, lines: poisoned.lines, variationOfLine: poisoned.variationOfLine, paidRevision: poisoned.paidRevision })!.digest;
  const guarded = createVoucherHoldFlow(prisma, { shopId: SHOP, attemptSecret: SECRET, proofSecret: SECRET, env: ENV, readPreview: async () => poisoned });
  assert.deepEqual(await guarded.hold({ cartId: c.id, expectedQuoteDigest: digest }), { ok: false, reason: "POS_INFEASIBLE" });
  assert.equal((await holdsOf()).length, 0);
  const row = await prisma.voucherCampaign.findUniqueOrThrow({ where: { id: m.id } });
  assert.deepEqual([row.reservedUses, row.reservedVnd], [0, BigInt(0)]);
});

test("a swap on a changed quote releases the old hold and holds the new one; choosing NONE releases everything", async () => {
  const c = await cart([{ variantId: await product(450_000), quantity: 2 }]);
  const small = await fixed(10_000, 100_000, { name: "small", maxUses: 5 });
  const big = await fixed(80_000, 100_000, { name: "big", maxUses: 5 });
  const selection = createVoucherSelectionService(prisma, { shopId: SHOP, env: ENV });
  const first = held(await click(c.id));
  assert.equal(first.holds[0]!.campaignId, big.id);
  await selection.setGroup({ cartId: c.id, group: "MERCHANDISE", mode: "MANUAL", voucherId: small.id });
  const swapped = held(await click(c.id));
  assert.equal(swapped.holds[0]!.campaignId, small.id);
  assert.deepEqual((await holdsOf()).map((h) => h.state), ["RELEASED", "HELD"]);
  assert.equal((await prisma.voucherCampaign.findUniqueOrThrow({ where: { id: big.id } })).reservedUses, 0);
  await selection.setGroup({ cartId: c.id, group: "MERCHANDISE", mode: "MANUAL", voucherId: null });
  const none = await click(c.id);
  assert.deepEqual(none.ok && none.state === "NONE" && none.released, ["MERCHANDISE"]);
  assert.equal((await prisma.voucherCampaign.findUniqueOrThrow({ where: { id: small.id } })).reservedUses, 0);
});

test("a cart whose paid lines moved after the preview is CART_CHANGED, and a voucher taken by someone else meanwhile is CAPACITY_EXHAUSTED; neither leaves a hold", async () => {
  const variantId = await product(450_000);
  const a = await cart([{ variantId, quantity: 2 }]);
  const b = await cart([{ variantId, quantity: 2 }]);
  await fixed(50_000, 600_000, { maxUses: 1 });

  // The preview b will act on is read first; then a takes the only use.
  const stalePreview = await shown(b.id);
  held(await click(a.id));
  const staleFlow = createVoucherHoldFlow(prisma, { shopId: SHOP, attemptSecret: SECRET, proofSecret: SECRET, env: ENV, readPreview: async () => stalePreview });
  assert.deepEqual(await staleFlow.hold({ cartId: b.id, expectedQuoteDigest: stalePreview.quoteDigest! }), { ok: false, reason: "CAPACITY_EXHAUSTED" });

  // Cart b changes after its preview was read (a paid line is added): the hold refuses the stale revision.
  await prisma.cartItem.create({ data: { cartId: b.id, variantId: await product(100_000), quantity: 1 } });
  assert.deepEqual(await staleFlow.hold({ cartId: b.id, expectedQuoteDigest: stalePreview.quoteDigest! }), { ok: false, reason: "CART_CHANGED" });
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
  const digest = (await shown(c.id)).quoteDigest!;
  held(await limited.hold({ cartId: c.id, expectedQuoteDigest: digest }));
  held(await limited.hold({ cartId: c.id, expectedQuoteDigest: digest }));
  assert.deepEqual(await limited.hold({ cartId: c.id, expectedQuoteDigest: digest }), { ok: false, reason: "RATE_LIMITED" });
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
