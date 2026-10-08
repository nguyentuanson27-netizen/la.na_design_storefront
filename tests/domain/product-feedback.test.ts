import assert from "node:assert/strict";
import test from "node:test";

import {
  createProductFeedbackRepository,
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

const brandOf = (variants: readonly FeedbackVariantRow[]) => mapFeedbackVariantsToImages(variants);
const BRAND_VARIANTS = [row("ANH-FEEDBACK-02", [KNOWN_2.src]), row("ANH-FEEDBACK-01", [KNOWN_1.src])];

test("a product with tagged photographs shows only its own, sizes unknown until calibrated", () => {
  const feedback = selectProductFeedback({
    productCode: "sv605",
    productCodeOwnerCount: 1,
    taggedVariants: [
      row("ANH-FEEDBACK-SV605", [UNCALIBRATED, KNOWN_3.src, UNCALIBRATED]),
      // A row the read should not have returned is still ignored: only the exact code counts.
      row("ANH-FEEDBACK-SV700", [UNCALIBRATED_2]),
    ],
    brandImages: brandOf(BRAND_VARIANTS),
  });

  assert.equal(feedback?.scope, "product");
  assert.equal(feedback?.hasBrandGallery, true);
  assert.deepEqual(feedback?.images, [
    { src: UNCALIBRATED, alt: "", width: null, height: null },
    { src: KNOWN_3.src, alt: "", width: KNOWN_3.width, height: KNOWN_3.height },
  ]);
});

test("a product code shared by two present products is ambiguous and falls back to the brand gallery", () => {
  const input = {
    productCode: "SV605",
    taggedVariants: [row("ANH-FEEDBACK-SV605", [UNCALIBRATED])],
    brandImages: brandOf(BRAND_VARIANTS),
  };
  for (const productCodeOwnerCount of [0, 2, 3]) {
    const feedback = selectProductFeedback({ ...input, productCodeOwnerCount });
    assert.equal(feedback?.scope, "brand", `owners: ${productCodeOwnerCount}`);
    assert.deepEqual(feedback?.images.map((image) => image.src), [KNOWN_1.src, KNOWN_2.src]);
  }
  assert.equal(selectProductFeedback({ ...input, productCodeOwnerCount: 1 })?.scope, "product");
});

test("a product without tagged photographs falls back to the brand gallery", () => {
  for (const productCode of ["SV605", null]) {
    const feedback = selectProductFeedback({
      productCode,
      productCodeOwnerCount: productCode === null ? 0 : 1,
      taggedVariants: [],
      brandImages: brandOf(BRAND_VARIANTS),
    });
    assert.equal(feedback?.scope, "brand");
    assert.deepEqual(feedback?.images.map((image) => image.src), [KNOWN_1.src, KNOWN_2.src]);
  }
});

test("the product page rail is capped, and absent when there is nothing to show", () => {
  const many = HOMEPAGE_CONFIG.feedback.images.map((image, index) =>
    row(`ANH-FEEDBACK-${String(index + 1).padStart(2, "0")}`, [image.src]),
  );
  const feedback = selectProductFeedback({
    productCode: null,
    productCodeOwnerCount: 0,
    taggedVariants: [],
    brandImages: brandOf(many),
  });
  assert.equal(
    feedback?.images.length,
    Math.min(PRODUCT_FEEDBACK_IMAGE_LIMIT, HOMEPAGE_CONFIG.feedback.images.length),
  );

  const empty = { productCodeOwnerCount: 1, brandImages: [] };
  assert.equal(selectProductFeedback({ ...empty, productCode: "SV605", taggedVariants: [] }), null);
});

test("many tagged variants and URLs still yield at most the cap, de-duplicated, in display-ID order", () => {
  const taggedVariants = Array.from({ length: 200 }, (_, variant) =>
    row("ANH-FEEDBACK-SV605", Array.from({ length: 10 }, (_, url) =>
      `https://content.pancake.vn/2-2610/2026/10/8/sv605-${(variant * 10 + url) % 1500}.jpg`)),
  );
  const feedback = selectProductFeedback({
    productCode: "SV605",
    productCodeOwnerCount: 1,
    taggedVariants,
    brandImages: [],
  });
  assert.equal(feedback?.images.length, PRODUCT_FEEDBACK_IMAGE_LIMIT);
  assert.equal(new Set(feedback?.images.map((image) => image.src)).size, PRODUCT_FEEDBACK_IMAGE_LIMIT);
});

test("padded tagged display IDs still name their product, and a longer code containing it does not", () => {
  const feedback = selectProductFeedback({
    productCode: "SV605",
    productCodeOwnerCount: 1,
    taggedVariants: [
      // The mirror stores Pancake's `display_id` untrimmed; the parser trims after the prefix.
      row("ANH-FEEDBACK-SV605 ", [UNCALIBRATED]),
      row("ANH-FEEDBACK- SV605", [KNOWN_3.src]),
      // A candidate the `contains` read returns but that names another product.
      row("ANH-FEEDBACK-SV6050", [UNCALIBRATED_2]),
    ],
    brandImages: [],
  });
  assert.equal(feedback?.scope, "product");
  assert.deepEqual(feedback?.images.map((image) => image.src), [KNOWN_3.src, UNCALIBRATED]);
});

type Call = Readonly<{ method: string; where: unknown }>;

const isTagRead = (where: { pancakeDisplayId: object }) => "contains" in where.pancakeDisplayId;

function fakeClient(
  calls: Call[],
  {
    productCode = "SV605",
    owners = 1,
    failBrand = false,
    failTag = false,
    tagged = [row("ANH-FEEDBACK-SV605 ", [UNCALIBRATED])],
  }: {
    productCode?: string | null;
    owners?: number;
    failBrand?: boolean;
    failTag?: boolean;
    tagged?: FeedbackVariantRow[];
  } = {},
): ProductFeedbackReadClient {
  return {
    variantMirror: {
      async findMany(args) {
        calls.push({ method: "variantMirror.findMany", where: args.where });
        if (isTagRead(args.where)) {
          if (failTag) throw new Error("connection reset");
          return tagged;
        }
        if (failBrand) throw new Error("statement timeout");
        return [row("ANH-FEEDBACK-01", [KNOWN_1.src])];
      },
    },
    productMirror: {
      async findFirst(args) {
        calls.push({ method: "productMirror.findFirst", where: args.where });
        return { productCode };
      },
      async count(args) {
        calls.push({ method: "productMirror.count", where: args.where });
        return owners;
      },
    },
  };
}

test("readProductFeedback reads only the product's candidate tags and counts who else carries its code", async () => {
  const calls: Call[] = [];
  const feedback = await readProductFeedback({ client: fakeClient(calls), shopId: 7, productId: "prod-1" });

  assert.equal(feedback?.scope, "product");
  assert.deepEqual(
    calls.map((call) => call.method).sort(),
    ["productMirror.count", "productMirror.findFirst", "variantMirror.findMany", "variantMirror.findMany"],
  );
  assert.deepEqual(calls.find((call) => call.method === "productMirror.findFirst")?.where, { id: "prod-1", pancakeShopId: 7 });
  assert.deepEqual(calls.find((call) => call.method === "productMirror.count")?.where, {
    pancakeShopId: 7,
    isPresent: true,
    productCode: { equals: "SV605", mode: "insensitive" },
  });
  const variantReads = calls.filter((call) => call.method === "variantMirror.findMany").map((call) => call.where);
  assert.deepEqual(variantReads, [
    { isPresent: true, pancakeDisplayId: { startsWith: "ANH-FEEDBACK-" }, product: { pancakeShopId: 7 } },
    {
      isPresent: true,
      pancakeDisplayId: { startsWith: "ANH-FEEDBACK-", contains: "SV605", mode: "insensitive" },
      product: { pancakeShopId: 7 },
    },
  ]);
});

test("readProductFeedback falls back to the brand gallery when the code is ambiguous in the shop", async () => {
  const feedback = await readProductFeedback({ client: fakeClient([], { owners: 2 }), shopId: 7, productId: "prod-1" });
  assert.equal(feedback?.scope, "brand");
  assert.deepEqual(feedback?.images.map((image) => image.src), [KNOWN_1.src]);
});

test("a product without a code makes no tag read at all", async () => {
  const calls: Call[] = [];
  const feedback = await readProductFeedback({ client: fakeClient(calls, { productCode: null }), shopId: 7, productId: "p" });
  assert.equal(feedback?.scope, "brand");
  assert.deepEqual(calls.map((call) => call.method).sort(), ["productMirror.findFirst", "variantMirror.findMany"]);
});

test("the brand gallery read is shared across product pages per shop until its TTL", async () => {
  const calls: Call[] = [];
  let clock = 1_000;
  const repository = createProductFeedbackRepository(fakeClient(calls), { now: () => clock, ttlMs: 60_000 });
  const brandReads = () =>
    calls.filter((call) => call.method === "variantMirror.findMany" && !isTagRead(call.where as { pancakeDisplayId: object })).length;

  await Promise.all([
    repository.readProductFeedback({ shopId: 7, productId: "a" }),
    repository.readProductFeedback({ shopId: 7, productId: "b" }),
  ]);
  await repository.readProductFeedback({ shopId: 7, productId: "c" });
  assert.equal(brandReads(), 1);

  await repository.readProductFeedback({ shopId: 8, productId: "a" });
  assert.equal(brandReads(), 2, "another shop has its own entry");

  clock += 60_001;
  await repository.readProductFeedback({ shopId: 7, productId: "a" });
  assert.equal(brandReads(), 3, "expired entries are re-read");
});

test("a failed brand read keeps the product's own photographs and is not cached", async () => {
  const calls: Call[] = [];
  let failBrand = true;
  const client = fakeClient(calls);
  const flaky: ProductFeedbackReadClient = {
    ...client,
    variantMirror: {
      async findMany(args) {
        if (failBrand && !isTagRead(args.where)) throw new Error("statement timeout");
        return client.variantMirror.findMany(args);
      },
    },
  };
  const repository = createProductFeedbackRepository(flaky, { now: () => 0 });

  const during = await repository.readProductFeedback({ shopId: 7, productId: "a" });
  assert.equal(during?.scope, "product");
  assert.equal(during?.hasBrandGallery, false, "no /feedback link while the brand gallery is unknown");

  failBrand = false;
  const after = await repository.readProductFeedback({ shopId: 7, productId: "a" });
  assert.equal(after?.scope, "product");
  assert.equal(after?.hasBrandGallery, true, "the failed read was not cached");
});

test("readProductFeedback fails closed rather than failing the product page", async () => {
  // A failed brand read with nothing of the product's own leaves nothing to show.
  const noOwn = fakeClient([], { failBrand: true, tagged: [] });
  assert.equal(await readProductFeedback({ client: noOwn, shopId: 7, productId: "prod-1" }), null);
  // A failed tag read cannot be told from "no photographs", so the rail is omitted entirely.
  const tagDown = fakeClient([], { failTag: true });
  assert.equal(await readProductFeedback({ client: tagDown, shopId: 7, productId: "prod-1" }), null);
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
