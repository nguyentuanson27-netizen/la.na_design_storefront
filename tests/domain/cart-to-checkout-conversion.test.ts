import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { FULFILLMENT, ORDER_TRUST_FACTS, ORDER_TRUST_SHORT } from "../../src/brand/index.ts";
import type { StorefrontCartLine } from "../../src/commerce/storefront-cart.ts";
import { CART_DRAWER_EXIT_EVENT, cartDrawerExitParameters } from "../../src/components/headless/cart-drawer-model.ts";
import { benefitCheckoutPixelParameters, type CheckoutViewModel } from "../../src/routes/checkout-model.ts";

/**
 * Cart → checkout: the reassurance line under the order button, a single primary action in the
 * drawer, the "mua thêm" nudge said as optional, and the measurements that tell whether any of it
 * moves the cart → checkout rate (InitiateCheckout on gift checkouts, how shoppers leave the drawer).
 */

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const read = (file: string) => readFileSync(path.join(REPO_ROOT, file), "utf8");

test("the order trust line is derived from the approved payment and returns policy", () => {
  assert.equal(FULFILLMENT.payment.inspectionNote, "Được kiểm tra hàng trước khi thanh toán.");
  assert.equal(FULFILLMENT.payment.codNote, "Thanh toán khi nhận hàng (COD).");
  assert.equal(FULFILLMENT.payment.inspectionShortNote, "Được kiểm hàng");
  assert.deepEqual(ORDER_TRUST_FACTS, [
    "COD",
    "Được kiểm hàng",
    `Đổi trả ${FULFILLMENT.returns.windowDays} ngày`,
  ]);
  assert.equal(FULFILLMENT.returns.windowDays, 15);
  // The sticky bar's one-line form is the same three facts.
  assert.equal(ORDER_TRUST_SHORT, "COD · Được kiểm hàng · Đổi trả 15 ngày");
});

test("the mobile sticky order bar carries the short trust line on the cart page and checkout", () => {
  assert.match(read("src/components/brand/mobile-sticky-cta.tsx"), /data-mobile-sticky-footnote/);
  for (const file of ["src/app/cart/page.tsx", "src/components/commerce/guest-checkout-form.tsx"]) {
    assert.match(read(file), /footnote=\{ORDER_TRUST_SHORT\}/, file);
  }
});

test("the trust line sits under every order button: drawer, cart page and checkout", () => {
  for (const file of ["src/components/brand/cart-drawer.tsx", "src/app/cart/page.tsx", "src/components/commerce/guest-checkout-form.tsx"]) {
    assert.match(read(file), /<OrderTrustLine\b/, file);
  }
  // The component renders Brand Config facts; it never words a policy of its own.
  const line = read("src/components/brand/order-trust-line.tsx");
  assert.match(line, /ORDER_TRUST_FACTS\.map/);
  assert.doesNotMatch(line, /ngày|kiểm tra|COD/);
  // One row: each fact stays whole, the row only breaks between facts.
  assert.match(line, /whitespace-nowrap/);
});

test("the drawer has one primary action; the cart page is a quiet link, not a second button", () => {
  const drawer = read("src/components/brand/cart-drawer.tsx");
  assert.equal(drawer.match(/btn btn--primary/g)?.length, 1);
  assert.doesNotMatch(drawer, /btn--outline w-full/);
  assert.match(drawer, /href="\/cart"[\s\S]{0,80}leave\("cart"\)[\s\S]{0,200}Xem chi tiết giỏ hàng/);
});

test("the next milestone sits in the drawer's fixed footer; reached promotions follow the lines", () => {
  const drawer = read("src/components/brand/cart-drawer.tsx");
  assert.ok(drawer.indexOf("<PromotionBanner") > drawer.indexOf("cart.lines.map"), "reached promotions render after the lines");
  // The scrolling body never lists the "mua thêm" milestone; the footer carries exactly one.
  assert.match(drawer, /items: cart\.promotions\.items\.filter\(\(item\) => item\.state !== "progress"\)/);
  assert.ok(drawer.indexOf("<PromotionProgressLine") > drawer.indexOf("{/* Footer */}"), "milestone renders in the footer");
  assert.match(drawer, /firstPromotionProgress\(cart\.promotions\)/);
  // Owner decision (25/10/2026): no "Không bắt buộc" note anywhere.
  for (const file of ["src/components/brand/promotion-banner.tsx", "src/components/brand/cart-drawer.tsx", "src/app/cart/page.tsx"]) {
    assert.doesNotMatch(read(file), /Không bắt buộc|progressNote/, file);
  }
});

test("every way out of the drawer is reported with where it led", () => {
  assert.equal(CART_DRAWER_EXIT_EVENT, "CartDrawerExit");
  assert.deepEqual(cartDrawerExitParameters("checkout", { giftNudgeAvailable: true, giftNudgeSeen: false, canCheckout: true }), {
    exit_to: "checkout",
    gift_nudge_available: true,
    gift_nudge_seen: false,
    can_checkout: true,
  });
  // Seen implies available: an observation left from a nudge that has since gone says nothing.
  assert.equal(cartDrawerExitParameters("close", { giftNudgeAvailable: false, giftNudgeSeen: true, canCheckout: true }).gift_nudge_seen, false);
  const drawer = read("src/components/brand/cart-drawer.tsx");
  for (const exit of ["checkout", "cart", "product", "gift", "close"]) {
    assert.match(drawer, new RegExp(`leave\\("${exit}"\\)`), exit);
  }
  // Exposure is observed on the milestone line itself and reset on every opening.
  assert.match(drawer, /lineRef=\{observeNudge\}/);
  assert.match(drawer, /nudgeSeenRef\.current = false;/);
  // Escape, the backdrop and the close button are all the same "close" exit.
  assert.equal(drawer.match(/\{dismiss\}|dismiss\(\);/g)?.length, 3);
});

const line = (slug: string) => ({ productSlug: slug, metaContentId: null }) as unknown as StorefrontCartLine;

function benefitCheckout(overrides: Partial<CheckoutViewModel> = {}): CheckoutViewModel {
  return {
    state: "ready",
    lines: [{ quantity: 2 }, { quantity: 1 }],
    totals: { subtotalText: "", shippingText: "Miễn phí", totalText: "", totalVnd: 1_598_000 },
    quoteProof: "proof",
    preorderNotice: null,
    benefit: {},
    unavailableNotice: null,
    ...overrides,
  } as unknown as CheckoutViewModel;
}

test("a gift checkout still reports InitiateCheckout, with the shown total and no invented unit price", () => {
  const parameters = benefitCheckoutPixelParameters(benefitCheckout(), [line("set-vay"), line("ao-lua")]);
  assert.deepEqual(parameters, {
    content_ids: ["set-vay", "ao-lua"],
    content_type: "product",
    currency: "VND",
    value: 1_598_000,
    num_items: 3,
  });
  assert.equal("contents" in (parameters ?? {}), false);
});

test("a gift checkout that cannot be submitted, or has an unnameable product, reports nothing", () => {
  const lines = [line("set-vay")];
  assert.equal(benefitCheckoutPixelParameters(benefitCheckout({ state: "unquotable" } as Partial<CheckoutViewModel>), lines), null);
  assert.equal(benefitCheckoutPixelParameters(benefitCheckout({ totals: null }), lines), null);
  assert.equal(benefitCheckoutPixelParameters(benefitCheckout({ benefit: null }), lines), null);
  assert.equal(benefitCheckoutPixelParameters(benefitCheckout(), [line("set-vay"), line("")]), null);
});

test("checkout wires the gift-checkout InitiateCheckout through the signed CAPI path", () => {
  const checkout = read("src/routes/checkout.ts");
  assert.match(checkout, /benefitCheckoutPixelParameters\(data, lines\)/);
  assert.match(checkout, /name: "InitiateCheckout", capiPath: "\/checkout", parameters: benefitPixel/);
});
