import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { handleDrawerFocusTrap } from "../../src/components/headless/cart-drawer-model.ts";
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

  // Focus restore prioritizes actual opener over desktop trigger
  assert.match(source, /previouslyFocusedElement\.current \?\? triggerRef\?\.current/);
});

test("F2d cart drawer focus trap: safely handles null container", () => {
  const event = { key: "Tab", shiftKey: false, preventDefault() {} } as unknown as KeyboardEvent;
  assert.doesNotThrow(() => handleDrawerFocusTrap(event, null));
});
