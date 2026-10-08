import assert from "node:assert/strict";
import test from "node:test";

import {
  mapFeedbackVariantsToImages,
  parseFeedbackProductCode,
  PRODUCT_FEEDBACK_IMAGE_LIMIT,
  readProductFeedback,
  selectProductFeedback,
  type FeedbackVariantRow,
  type ProductFeedbackReadClient,
} from "../../src/commerce/feedback-repository.ts";
import { DEFAULT_GUEST_SHIPPING_POLICY } from "../../src/commerce/guest-shipping-policy.ts";
import { FULFILLMENT } from "../../src/brand/index.ts";
import { HOMEPAGE_CONFIG } from "../../src/content/homepage.config.ts";
import { buildPurchaseAssuranceViewModel } from "../../src/routes/evergreen-model.ts";
import { buildProductFeedbackSection } from "../../src/routes/product-model.ts";

/**
 * Product page conversion surfaces: customer photographs tagged to a product
 * (`ANH-FEEDBACK-<product code>`), the brand fallback, and the buying facts under the purchase
 * buttons.
 */

const KNOWN_1 = HOMEPAGE_CONFIG.feedback.images[0]!;
const KNOWN_2 = HOMEPAGE_CONFIG.feedback.images[1]!;
const KNOWN_3 = HOMEPAGE_CONFIG.feedback.images[2]!;
const UNCALIBRATED = "https://content.pancake.vn/2-2610/2026/10/8/sv605-khach-01.jpg";
const UNCALIBRATED_2 = "https://content.pancake.vn/2-2610/2026/10/8/sv605-khach-02.jpg";

const row = (pancakeDisplayId: string, urls: readonly string[]): FeedbackVariantRow => ({
  id: `var-${pancakeDisplayId}`,
  pancakeDisplayId,
  pancakeImageUrls: [...urls],
});

test("parseFeedbackProductCode reads a product code, and only a product code", () => {
  assert.equal(parseFeedbackProductCode("ANH-FEEDBACK-SV605"), "SV605");
  assert.equal(parseFeedbackProductCode("ANH-FEEDBACK-sv605"), "SV605");
  assert.equal(parseFeedbackProductCode("ANH-FEEDBACK-SV605-2"), "SV605-2");
  assert.equal(parseFeedbackProductCode("ANH-FEEDBACK-01"), null);
  assert.equal(parseFeedbackProductCode("ANH-FEEDBACK-12"), null);
  assert.equal(parseFeedbackProductCode("NOT-ANH-FEEDBACK-SV605"), null);
  assert.equal(parseFeedbackProductCode(null), null);
});

test("an uncalibrated product photograph never empties the brand gallery", () => {
  const images = mapFeedbackVariantsToImages([
    row("ANH-FEEDBACK-01", [KNOWN_1.src]),
    row("ANH-FEEDBACK-SV605", [UNCALIBRATED]),
  ]);
  assert.deepEqual(images.map((image) => image.src), [KNOWN_1.src]);
});

test("a calibrated product photograph also joins the brand gallery", () => {
  const images = mapFeedbackVariantsToImages([
    row("ANH-FEEDBACK-01", [KNOWN_1.src]),
    row("ANH-FEEDBACK-SV605", [KNOWN_2.src]),
  ]);
  assert.deepEqual(images.map((image) => image.src), [KNOWN_1.src, KNOWN_2.src]);
});

test("an uncalibrated brand photograph still fails the gallery closed", () => {
  const images = mapFeedbackVariantsToImages([
    row("ANH-FEEDBACK-01", [KNOWN_1.src, UNCALIBRATED]),
    row("ANH-FEEDBACK-SV605", [KNOWN_2.src]),
  ]);
  assert.deepEqual(images, []);
});

test("a product with tagged photographs shows only its own, sizes unknown until calibrated", () => {
  const feedback = selectProductFeedback(
    [
      row("ANH-FEEDBACK-01", [KNOWN_1.src]),
      row("ANH-FEEDBACK-SV605", [UNCALIBRATED, KNOWN_3.src, UNCALIBRATED]),
      row("ANH-FEEDBACK-SV700", [UNCALIBRATED_2]),
    ],
    "sv605",
  );

  assert.equal(feedback?.scope, "product");
  assert.equal(feedback?.hasBrandGallery, true);
  assert.deepEqual(feedback?.images, [
    { src: UNCALIBRATED, alt: "", width: null, height: null },
    { src: KNOWN_3.src, alt: "", width: KNOWN_3.width, height: KNOWN_3.height },
  ]);
});

test("a product without tagged photographs falls back to the brand gallery", () => {
  const variants = [
    row("ANH-FEEDBACK-02", [KNOWN_2.src]),
    row("ANH-FEEDBACK-01", [KNOWN_1.src]),
    row("ANH-FEEDBACK-SV700", [UNCALIBRATED]),
  ];
  for (const productCode of ["SV605", null]) {
    const feedback = selectProductFeedback(variants, productCode);
    assert.equal(feedback?.scope, "brand");
    assert.deepEqual(feedback?.images.map((image) => image.src), [KNOWN_1.src, KNOWN_2.src]);
  }
});

test("the product page rail is capped, and absent when there is nothing to show", () => {
  const many = HOMEPAGE_CONFIG.feedback.images.map((image, index) =>
    row(`ANH-FEEDBACK-${String(index + 1).padStart(2, "0")}`, [image.src]),
  );
  const feedback = selectProductFeedback(many, null);
  assert.equal(
    feedback?.images.length,
    Math.min(PRODUCT_FEEDBACK_IMAGE_LIMIT, HOMEPAGE_CONFIG.feedback.images.length),
  );

  assert.equal(selectProductFeedback([], "SV605"), null);
  assert.equal(selectProductFeedback([row("ANH-FEEDBACK-SV700", [UNCALIBRATED])], "SV605"), null);
});

test("readProductFeedback scopes both reads to the shop and the product", async () => {
  const calls: unknown[] = [];
  const client: ProductFeedbackReadClient = {
    variantMirror: {
      async findMany(args) {
        calls.push(args.where);
        return [row("ANH-FEEDBACK-01", [KNOWN_1.src]), row("ANH-FEEDBACK-SV605", [UNCALIBRATED])];
      },
    },
    productMirror: {
      async findFirst(args) {
        calls.push(args.where);
        return { productCode: "SV605" };
      },
    },
  };

  const feedback = await readProductFeedback({ client, shopId: 7, productId: "prod-1" });
  assert.equal(feedback?.scope, "product");
  assert.deepEqual(calls, [
    { isPresent: true, pancakeDisplayId: { startsWith: "ANH-FEEDBACK-" }, product: { pancakeShopId: 7 } },
    { id: "prod-1", pancakeShopId: 7 },
  ]);
});

test("readProductFeedback fails closed rather than failing the product page", async () => {
  const client: ProductFeedbackReadClient = {
    variantMirror: {
      async findMany() {
        throw new Error("connection reset");
      },
    },
    productMirror: {
      async findFirst() {
        return null;
      },
    },
  };
  assert.equal(await readProductFeedback({ client, shopId: 7, productId: "prod-1" }), null);
});

test("the rail's heading says whose photographs these are", () => {
  const images = [{ src: KNOWN_1.src, alt: "", width: KNOWN_1.width, height: KNOWN_1.height }];

  const own = buildProductFeedbackSection(
    { scope: "product", images, hasBrandGallery: true },
    HOMEPAGE_CONFIG.feedback,
  );
  assert.equal(own?.title, HOMEPAGE_CONFIG.feedback.productPageTitle);
  assert.equal(own?.href, "/feedback");

  const brand = buildProductFeedbackSection(
    { scope: "brand", images, hasBrandGallery: true },
    HOMEPAGE_CONFIG.feedback,
  );
  assert.equal(brand?.title, HOMEPAGE_CONFIG.feedback.title);

  // No brand gallery means `/feedback` 404s, so the rail links nowhere.
  const ownOnly = buildProductFeedbackSection(
    { scope: "product", images, hasBrandGallery: false },
    HOMEPAGE_CONFIG.feedback,
  );
  assert.equal(ownOnly?.href, null);

  // A scope with no approved heading omits the rail instead of borrowing the other heading.
  assert.equal(
    buildProductFeedbackSection(
      { scope: "product", images, hasBrandGallery: true },
      { ...HOMEPAGE_CONFIG.feedback, productPageTitle: "  " },
    ),
    null,
  );
  assert.equal(buildProductFeedbackSection(null, HOMEPAGE_CONFIG.feedback), null);
});

test("the buying facts under the purchase buttons are derived from their authorities", () => {
  const items = buildPurchaseAssuranceViewModel({ policy: DEFAULT_GUEST_SHIPPING_POLICY });
  assert.deepEqual(items, [
    { key: "cod", label: "Thanh toán khi nhận hàng (COD)", href: null },
    { key: "returns", label: `Đổi trả trong ${FULFILLMENT.returns.windowDays} ngày`, href: "/returns" },
    { key: "free-shipping", label: "Free ship từ 3 sản phẩm hoặc đơn trên 1 triệu", href: "/shipping" },
  ]);

  const custom = buildPurchaseAssuranceViewModel({
    policy: { feeVnd: 25_000, freeShippingSubtotalVnd: 800_000, freeShippingMinQuantity: 2 },
  });
  assert.equal(custom[2]?.label, "Free ship từ 2 sản phẩm hoặc đơn trên 800 nghìn");
});
