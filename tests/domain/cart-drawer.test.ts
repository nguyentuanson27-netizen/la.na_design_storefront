import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { checkoutBlockedMessages, handleDrawerFocusTrap, isMeaningfulReturnFocusTarget } from "../../src/components/headless/cart-drawer-model.ts";
import { buildCartViewModel } from "../../src/routes/cart-model.ts";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

test("F2d cart drawer: builds accessible view model with empty and populated states", () => {
  const emptyCart = buildCartViewModel({ lines: [], commerceTrackingEnabled: false });
  assert.equal(emptyCart.isEmpty, true);
  assert.equal(emptyCart.lineCount, 0);
  assert.equal(emptyCart.lines.length, 0);

  const populatedCart = buildCartViewModel({
    lines: [
      {
        variantId: "v1",
        pancakeVariationId: "pv1",
        pancakeProductId: "pp1",
        productSlug: "ao-dai-lua",
        productName: "Áo dài lụa",
        color: "Đỏ",
        size: "M",
        quantity: 2,
        price: 850_000,
        available: true,
        isPreorderSale: false,
        unavailableReason: null,
        media: { primary: null, gallery: [] },
      },
    ],
    commerceTrackingEnabled: false,
  });

  assert.equal(populatedCart.isEmpty, false);
  assert.equal(populatedCart.lineCount, 1);
  assert.equal(populatedCart.lines[0]?.quantity, 2);
  assert.equal(populatedCart.canCheckout, true);
  assert.equal(populatedCart.subtotalText.includes("1.700.000"), true);
});

test("F2d cart drawer: unavailable lines disable checkout and provide honest labels", () => {
  const cartWithUnavailable = buildCartViewModel({
    lines: [
      {
        variantId: "v2",
        pancakeVariationId: "pv2",
        pancakeProductId: "pp2",
        productSlug: "vay-linen",
        productName: "Váy linen",
        color: "Be",
        size: "S",
        quantity: 1,
        price: 450_000,
        available: false,
        isPreorderSale: false,
        unavailableReason: "OUT_OF_STOCK",
        media: { primary: null, gallery: [] },
      },
    ],
    commerceTrackingEnabled: false,
  });

  assert.equal(cartWithUnavailable.canCheckout, false);
  assert.equal(cartWithUnavailable.hasUnavailableLines, true);
  assert.equal(cartWithUnavailable.lines[0]?.availabilityLabel, "Tạm hết hàng");
});

test("F2d cart drawer component: enforces accessible dialog contracts and Escape dismissal", () => {
  const source = readFileSync(
    path.join(REPO_ROOT, "src/components/brand/cart-drawer.tsx"),
    "utf8",
  );

  // Accessible dialog semantics
  assert.match(source, /role="dialog"/);
  assert.match(source, /aria-modal="true"/);
  assert.match(source, /aria-label="Giỏ hàng"/);

  // Escape key and focus trap handlers
  assert.match(source, /event\.key === "Escape"/);
  assert.match(source, /handleDrawerFocusTrap/);

  // Must have close button with accessible label
  assert.match(source, /aria-label="Đóng giỏ hàng"/);

  // Focus restore prefers the real opener, and falls back to the drawer's own trigger when there
  // was none. The decision itself is pinned by its own tests below.
  assert.match(source, /isMeaningfulReturnFocusTarget\(saved\) \? saved : triggerRef\?\.current/);
});

test("F2d cart drawer return focus: a real opener wins, an empty one defers to the trigger", () => {
  const opener = { isConnected: true, tagName: "BUTTON", focus() {} };
  assert.equal(isMeaningfulReturnFocusTarget(opener), true);

  // What `document.activeElement` reports when the drawer is opened programmatically rather than
  // from a control -- the mobile purchase sheet closes and unmounts before requesting the cart.
  // Returning focus here is the same as dropping it on the floor.
  assert.equal(
    isMeaningfulReturnFocusTarget({ isConnected: true, tagName: "BODY", focus() {} }),
    false,
  );
  assert.equal(
    isMeaningfulReturnFocusTarget({ isConnected: true, tagName: "HTML", focus() {} }),
    false,
  );

  // An opener that has since left the document cannot take focus either.
  assert.equal(
    isMeaningfulReturnFocusTarget({ isConnected: false, tagName: "BUTTON", focus() {} }),
    false,
  );

  // Defensive: something that is not focusable at all, and nothing saved.
  assert.equal(isMeaningfulReturnFocusTarget({ isConnected: true, tagName: "DIV" }), false);
  assert.equal(isMeaningfulReturnFocusTarget(null), false);

  // Tag casing comes from the parser, not the author.
  assert.equal(
    isMeaningfulReturnFocusTarget({ isConnected: true, tagName: "body", focus() {} }),
    false,
  );
});

test("F2d cart drawer focus trap: safely handles null container", () => {
  const event = { key: "Tab", shiftKey: false, preventDefault() {} } as unknown as KeyboardEvent;
  assert.doesNotThrow(() => handleDrawerFocusTrap(event, null));
});

test("F2d cart drawer: a blocked cart lists every reason, not only the first", () => {
  const unavailable = "Nàng điều chỉnh sản phẩm không khả dụng trước khi đặt hàng nhé.";
  const giftNotice = "Quà nàng chọn không còn hợp lệ, có thể do số lượng sản phẩm vừa thay đổi nên chương trình tặng quà chuyển sang quà khác. Nàng chọn lại quà trong giỏ hàng trước khi đặt hàng nhé.";

  // (e) an unavailable line and an invalid gift at once: both are said, as the cart page does.
  assert.deepEqual(checkoutBlockedMessages({ hasUnavailableLines: true, benefitsNotice: giftNotice }), [unavailable, giftNotice]);
  assert.deepEqual(checkoutBlockedMessages({ hasUnavailableLines: true }), [unavailable]);
  assert.deepEqual(checkoutBlockedMessages({ hasUnavailableLines: false, benefitsNotice: giftNotice }), [giftNotice]);
  assert.deepEqual(checkoutBlockedMessages({ hasUnavailableLines: false }), ["Nàng xem lại giỏ hàng trước khi đặt hàng nhé."]);

  // The sentences are the cart model's own: an unavailable line never claims the gift is fine, and a
  // real cart view model that is blocked for both reasons hands the drawer both.
  const line = (available: boolean) => ({
    variantId: available ? "v1" : "v2", pancakeVariationId: "pv", pancakeProductId: "pp", productSlug: "ao", productName: "Áo",
    color: "Đỏ", size: "M", quantity: 1, price: 450_000, available, isPreorderSale: false,
    unavailableReason: available ? null : "OUT_OF_STOCK", media: { primary: null, gallery: [] },
  }) as never;
  const view = buildCartViewModel({
    lines: [line(true), line(false)], commerceTrackingEnabled: false,
    giftState: { quote: { lines: [], benefits: { enabled: false } }, labels: [], campaigns: [], entitlements: [], selections: [], validation: { ok: false, issues: [] } } as never,
  });
  assert.equal(view.canCheckout, false);
  assert.deepEqual(checkoutBlockedMessages(view), [unavailable, giftNotice]);
});

test("F2d cart drawer component: renders the blocked-checkout reasons through the model", () => {
  const source = readFileSync(path.join(REPO_ROOT, "src/components/brand/cart-drawer.tsx"), "utf8");
  assert.match(source, /checkoutBlockedMessages\(cart\)\.map/);
});
