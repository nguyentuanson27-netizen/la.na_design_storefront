import assert from "node:assert/strict";
import test from "node:test";

import { allocateMerchandiseDiscount, type VoucherPaidLine } from "../../src/commerce/voucher-allocation.ts";
import { canProjectExactMoney } from "../../src/commerce/pancake-voucher-projection.ts";
import { applyAllocationToLines } from "../../src/commerce/voucher-quote.ts";

/**
 * Offline POS fixtures (V00 / docs/integrations/pancake-voucher-acceptance.md).
 *
 * They show how a voucher allocation composes with the existing Pancake gift projection (ADR 0016 D-08):
 * the website quote keeps exact prices, the vendor sees line prices only. Nothing here calls Pancake; these
 * are the offline inputs V09 turns into `canProjectExactMoney` and H1-V checks against a sandbox readback.
 */

type SourceLine = VoucherPaidLine & Readonly<{ pancakeVariationId: string }>;
const line = (lineId: string, pancakeVariationId: string, quantity: number, unitPriceVnd: number): SourceLine => ({
  lineId,
  pancakeVariationId,
  product: { productId: lineId, shopId: "shop-1", categoryKeys: [] },
  quantity,
  unitPriceVnd,
});

function projectVoucherCart(lines: readonly SourceLine[], discountVnd: number, gifts: readonly { pancakeVariationId: string; quantity: number }[] = []) {
  const allocated = allocateMerchandiseDiscount({ lines, resolver: () => true, discountVnd });
  assert.equal(allocated.ok, true, JSON.stringify(allocated));
  const allocation = (allocated as { allocation: Parameters<typeof applyAllocationToLines>[1] }).allocation;
  const variationOf = new Map(lines.map((l) => [l.lineId, l.pancakeVariationId]));
  const paidLines = applyAllocationToLines(lines, allocation).map((l) => ({
    lineId: l.lineId,
    pancakeVariationId: variationOf.get(l.lineId.replace(/\|v\d+$/, ""))!,
    quantity: l.quantity,
    unitPriceVnd: l.unitPriceVnd,
  }));
  const paid = lines.reduce((sum, l) => sum + l.quantity * l.unitPriceVnd, 0) - discountVnd;
  return canProjectExactMoney({ paidLines, gifts, expectedPaidSubtotalVnd: paid, shippingFeeVnd: 30_000, expectedTotalVnd: paid + 30_000 });
}

test("F1: three units of one variation split a 10.000đ voucher into 2 x 96.667 + 1 x 96.666 and total 290.000", () => {
  const projection = projectVoucherCart([line("a", "V1", 3, 100_000)], 10_000);
  assert.deepEqual(projection, {
    ok: true,
    lines: [
      { pancakeVariationId: "V1", quantity: 2, unitPriceVnd: 96_667 },
      { pancakeVariationId: "V1", quantity: 1, unitPriceVnd: 96_666 },
    ],
    hash: (projection as { hash: string }).hash,
    paidTotalVnd: 290_000,
  });
});

test("F2: the same variation on two website lines stays two vendor lines at different prices, total 550.000", () => {
  const projection = projectVoucherCart([line("a", "V1", 1, 300_000), line("b", "V1", 2, 150_000)], 50_000);
  assert.equal(projection.ok, true);
  const lines = (projection as { lines: readonly { pancakeVariationId: string; quantity: number; unitPriceVnd: number }[] }).lines;
  assert.deepEqual(lines, [
    { pancakeVariationId: "V1", quantity: 1, unitPriceVnd: 275_000 },
    { pancakeVariationId: "V1", quantity: 2, unitPriceVnd: 137_500 },
  ]);
  assert.equal((projection as { paidTotalVnd: number }).paidTotalVnd, 550_000);
});

test("F3: voucher first, then the 1.000đ gift offset; the vendor total still equals the website total", () => {
  const projection = projectVoucherCart([line("a", "V1", 2, 250_000), line("b", "V2", 1, 150_000)], 80_000, [{ pancakeVariationId: "G1", quantity: 1 }]);
  assert.equal(projection.ok, true, JSON.stringify(projection));
  const ok = projection as { lines: readonly { quantity: number; unitPriceVnd: number }[]; paidTotalVnd: number };
  // Website paid total: 650.000 - 80.000 = 570.000. The gift's 1.000đ is carved out of a paid unit, not added.
  assert.equal(ok.paidTotalVnd, 570_000);
  assert.equal(ok.lines.reduce((sum, l) => sum + l.quantity * l.unitPriceVnd, 0), 570_000);
});

test("F5: a voucher that leaves no room for the gift's 1.000đ makes the cart unrepresentable (AC-20 / TG-02)", () => {
  // Voucher takes every spare đồng except the 1đ floor, so the gift offset has nowhere to come from.
  const lines = [line("a", "V1", 2, 2), line("b", "V2", 1, 1_000)];
  assert.equal(projectVoucherCart(lines, 1_000).ok, true, "without a gift the same voucher is fine");
  assert.deepEqual(projectVoucherCart(lines, 1_000, [{ pancakeVariationId: "G1", quantity: 2 }]), { ok: false, reason: "VENDOR_PROJECTION_INFEASIBLE" });
});
