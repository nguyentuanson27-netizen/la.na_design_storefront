import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { FULFILLMENT, ORDER_TRUST_FACTS } from "../../src/brand/index.ts";
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
  assert.deepEqual(ORDER_TRUST_FACTS, [
    "Thanh toán khi nhận hàng",
    "Được kiểm tra hàng trước khi thanh toán",
    `Đổi trả trong ${FULFILLMENT.returns.windowDays} ngày`,
  ]);
  assert.equal(FULFILLMENT.returns.windowDays, 15);
});

test("the trust line sits under every order button: drawer, cart page and checkout", () => {
  for (const file of ["src/components/brand/cart-drawer.tsx", "src/app/cart/page.tsx", "src/components/commerce/guest-checkout-form.tsx"]) {
    assert.match(read(file), /<OrderTrustLine\b/, file);
  }
  // The component renders Brand Config facts; it never words a policy of its own.
  const line = read("src/components/brand/order-trust-line.tsx");
  assert.match(line, /ORDER_TRUST_FACTS\.map/);
  assert.doesNotMatch(line, /ngày|kiểm tra|COD/);
});

test("the drawer has one primary action; the cart page is a quiet link, not a second button", () => {
  const drawer = read("src/components/brand/cart-drawer.tsx");
  assert.equal(drawer.match(/btn btn--primary/g)?.length, 1);
  assert.doesNotMatch(drawer, /btn--outline w-full/);
  assert.match(drawer, /href="\/cart"[\s\S]{0,80}leave\("cart"\)[\s\S]{0,200}Xem chi tiết giỏ hàng/);
});

test("the next-milestone nudge follows the lines and is said to be optional", () => {
  const drawer = read("src/components/brand/cart-drawer.tsx");
  assert.ok(drawer.indexOf("<PromotionBanner") > drawer.indexOf("cart.lines.map"), "banner renders after the lines");
  assert.match(drawer, /progressNote=\{PROMOTION_PROGRESS_NOTE\}/);
  assert.match(read("src/app/cart/page.tsx"), /progressNote=\{PROMOTION_PROGRESS_NOTE\}/);
  assert.match(read("src/components/brand/promotion-banner.tsx"), /Không bắt buộc/);
});

test("every way out of the drawer is reported with where it led", () => {
  assert.equal(CART_DRAWER_EXIT_EVENT, "CartDrawerExit");
  assert.deepEqual(cartDrawerExitParameters("checkout", { giftNudge: true, canCheckout: true }), {
    exit_to: "checkout",
    gift_nudge: true,
    can_checkout: true,
  });
  const drawer = read("src/components/brand/cart-drawer.tsx");
  for (const exit of ["checkout", "cart", "product", "gift", "close"]) {
    assert.match(drawer, new RegExp(`leave\\("${exit}"\\)`), exit);
  }
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
