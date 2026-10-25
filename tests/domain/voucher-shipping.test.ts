import assert from "node:assert/strict";
import test from "node:test";

import { allocateMerchandiseDiscount, type VoucherPaidLine } from "../../src/commerce/voucher-allocation.ts";
import {
  applyShippingVoucher,
  hasOtherPromotionsForCandidate,
  shippingScopeSubtotalAfterMerchandise,
} from "../../src/commerce/voucher-shipping.ts";
import { buildVoucherScopeResolver } from "../../src/commerce/voucher-scope.ts";
import { evaluateShippingCampaigns, type ShippingCampaign } from "../../src/commerce/shipping-campaign.ts";
import { DEFAULT_GUEST_SHIPPING_POLICY } from "../../src/commerce/guest-shipping-policy.ts";

const SHOP = "shop-1";
const line = (lineId: string, quantity: number, unitPriceVnd: number, categoryKeys: string[] = []): VoucherPaidLine => ({
  lineId,
  product: { productId: `p-${lineId}`, shopId: SHOP, categoryKeys },
  quantity,
  unitPriceVnd,
});

test("TG-10 B: a merchandise voucher that really discounts counts as another promotion; shipping vouchers never do", () => {
  assert.equal(hasOtherPromotionsForCandidate({ existingOtherPromotions: false, merchandiseDiscountVnd: 0 }), false);
  assert.equal(hasOtherPromotionsForCandidate({ existingOtherPromotions: false, merchandiseDiscountVnd: 1 }), true);
  assert.equal(hasOtherPromotionsForCandidate({ existingOtherPromotions: true, merchandiseDiscountVnd: 0 }), true);
});

test("the real shipping campaign engine drops a non-stacking campaign when the voucher flag is on (EX-06 inputs)", () => {
  const campaign: ShippingCampaign = {
    id: "free-ship",
    revision: 1,
    name: "Freeship đơn 1 sản phẩm",
    startsAt: null,
    endsAt: null,
    minimumQuantity: 1,
    priority: 1,
    stackingEnabled: false,
    scope: { mode: "DYNAMIC_CATEGORY", categoryKeys: ["vayDam"], includeProductIds: [], excludeProductIds: [] },
    isEnabled: true,
    enabledAt: new Date("2026-10-01T00:00:00Z"),
    disabledAt: null,
  };
  const feeFor = (hasOtherPromotions: boolean) =>
    evaluateShippingCampaigns({
      campaigns: [campaign],
      lines: [{ role: "PAID", product: { productId: "p1", categoryKeys: ["vayDam"] }, quantity: 1 }],
      policy: DEFAULT_GUEST_SHIPPING_POLICY,
      now: new Date("2026-10-25T00:00:00Z"),
      hasOtherPromotions,
    }).feeVnd;
  assert.equal(feeFor(hasOtherPromotionsForCandidate({ existingOtherPromotions: false, merchandiseDiscountVnd: 0 })), 0);
  assert.equal(feeFor(hasOtherPromotionsForCandidate({ existingOtherPromotions: false, merchandiseDiscountVnd: 10_000 })), 30_000);
  assert.equal(feeFor(hasOtherPromotionsForCandidate({ existingOtherPromotions: true, merchandiseDiscountVnd: 0 })), 30_000);
  // stackingEnabled=true keeps the campaign whatever the voucher does.
  const stacking = { ...campaign, stackingEnabled: true };
  assert.equal(
    evaluateShippingCampaigns({
      campaigns: [stacking],
      lines: [{ role: "PAID", product: { productId: "p1", categoryKeys: ["vayDam"] }, quantity: 1 }],
      policy: DEFAULT_GUEST_SHIPPING_POLICY,
      now: new Date("2026-10-25T00:00:00Z"),
      hasOtherPromotions: true,
    }).feeVnd,
    0,
  );
});

test("the shipping threshold is judged on the in-scope paid subtotal after the merchandise voucher (AC-09)", () => {
  const lines = [line("a", 1, 620_000)];
  const all = buildVoucherScopeResolver({ mode: "ALL_SHOP", excludeProductIds: [] }, SHOP);
  const merchandise = allocateMerchandiseDiscount({ lines, resolver: all, discountVnd: 50_000 });
  assert.equal(merchandise.ok, true);
  const allocation = merchandise.ok ? merchandise.allocation : null;
  assert.equal(shippingScopeSubtotalAfterMerchandise({ lines, resolver: all, merchandise: null }), 620_000);
  assert.equal(shippingScopeSubtotalAfterMerchandise({ lines, resolver: all, merchandise: allocation }), 570_000);
  assert.deepEqual(applyShippingVoucher({ feeVnd: 30_000, scopeSubtotalAfterVnd: 570_000, minEligibleSubtotalVnd: 600_000 }), {
    applies: false,
    reason: "BELOW_MINIMUM",
    shortfallVnd: 30_000,
    feeAfterVnd: 30_000,
  });
});

test("only in-scope lines count toward the shipping threshold; the merchandise deduction is subtracted where it landed", () => {
  const lines = [line("dress", 1, 500_000, ["vayDam"]), line("bag", 1, 200_000, ["phuKien"])];
  const dressOnly = buildVoucherScopeResolver({ mode: "TARGETED", categoryKeys: ["vayDam"], includeProductIds: [], excludeProductIds: [] }, SHOP);
  const all = buildVoucherScopeResolver({ mode: "ALL_SHOP", excludeProductIds: [] }, SHOP);
  const merchandise = allocateMerchandiseDiscount({ lines, resolver: all, discountVnd: 70_000 });
  assert.equal(merchandise.ok, true);
  const allocation = merchandise.ok ? merchandise.allocation : null;
  // 70.000 over 500.000 : 200.000 -> 50.000 on the dress, 20.000 on the bag.
  assert.equal(shippingScopeSubtotalAfterMerchandise({ lines, resolver: dressOnly, merchandise: allocation }), 450_000);
  assert.equal(shippingScopeSubtotalAfterMerchandise({ lines, resolver: all, merchandise: allocation }), 630_000);
});

test("AC-10 / EX-04: when the fee is already 0 a shipping voucher saves nothing and does not apply", () => {
  assert.deepEqual(applyShippingVoucher({ feeVnd: 0, scopeSubtotalAfterVnd: 900_000, minEligibleSubtotalVnd: 100_000 }), {
    applies: false,
    reason: "FEE_ALREADY_ZERO",
    shortfallVnd: null,
    feeAfterVnd: 0,
  });
});

test("a shipping voucher waives 100% of the remaining fee; no threshold means always eligible", () => {
  assert.deepEqual(applyShippingVoucher({ feeVnd: 30_000, scopeSubtotalAfterVnd: 600_000, minEligibleSubtotalVnd: 600_000 }), {
    applies: true,
    waivedFeeVnd: 30_000,
    feeAfterVnd: 0,
  });
  assert.equal(applyShippingVoucher({ feeVnd: 45_000, scopeSubtotalAfterVnd: 1, minEligibleSubtotalVnd: null }).applies, true);
});

test("invalid shipping voucher input is rejected, never rounded", () => {
  for (const input of [
    { feeVnd: -1, scopeSubtotalAfterVnd: 1, minEligibleSubtotalVnd: null },
    { feeVnd: 1.5, scopeSubtotalAfterVnd: 1, minEligibleSubtotalVnd: null },
    { feeVnd: 1, scopeSubtotalAfterVnd: -1, minEligibleSubtotalVnd: null },
  ]) {
    assert.throws(() => applyShippingVoucher(input), RangeError);
  }
});
