import assert from "node:assert/strict";
import test from "node:test";

import {
  createFeedbackRepository,
  mapFeedbackVariantsToImages,
  readDynamicFeedbackContent,
  type FeedbackReadClient,
  type FeedbackVariantRow,
} from "../../src/commerce/feedback-repository.ts";
import {
  resolveFeedbackContentWithImages,
} from "../../src/content/homepage-content.ts";
import { HOMEPAGE_CONFIG } from "../../src/content/homepage.config.ts";

const KNOWN_IMG_1 = HOMEPAGE_CONFIG.feedback.images[0]!;
const KNOWN_IMG_2 = HOMEPAGE_CONFIG.feedback.images[1]!;
const NEW_IMG_URL = "https://content.pancake.vn/2-2610/2026/10/2/test-photo-new-01.jpg";

test("mapFeedbackVariantsToImages publishes nothing when no ANH-FEEDBACK variants exist", () => {
  const images = mapFeedbackVariantsToImages([]);
  assert.deepEqual(images, []);
});

test("mapFeedbackVariantsToImages naturally sorts ANH-FEEDBACK variants by display ID", () => {
  const variants: FeedbackVariantRow[] = [
    {
      id: "var-2",
      pancakeDisplayId: "ANH-FEEDBACK-02",
      pancakeImageUrls: [KNOWN_IMG_2.src],
    },
    {
      id: "var-1",
      pancakeDisplayId: "ANH-FEEDBACK-01",
      pancakeImageUrls: [KNOWN_IMG_1.src],
    },
  ];

  const images = mapFeedbackVariantsToImages(variants);
  assert.equal(images.length, 2);
  assert.equal(images[0]?.src, KNOWN_IMG_1.src);
  assert.equal(images[1]?.src, KNOWN_IMG_2.src);
});

test("mapFeedbackVariantsToImages ignores variants outside the exact ANH-FEEDBACK- namespace", () => {
  const variants: FeedbackVariantRow[] = [
    {
      id: "wrong-prefix",
      pancakeDisplayId: "PROMO-FEEDBACK-01",
      pancakeImageUrls: [KNOWN_IMG_1.src],
    },
    {
      id: "substring-only",
      pancakeDisplayId: "NOT-ANH-FEEDBACK-02",
      pancakeImageUrls: [KNOWN_IMG_1.src],
    },
    {
      id: "valid",
      pancakeDisplayId: "ANH-FEEDBACK-03",
      pancakeImageUrls: [KNOWN_IMG_2.src],
    },
  ];

  const images = mapFeedbackVariantsToImages(variants);
  assert.deepEqual(
    images.map((image) => image.src),
    [KNOWN_IMG_2.src],
  );
});

test("mapFeedbackVariantsToImages deduplicates repeated URLs across variants", () => {
  const variants: FeedbackVariantRow[] = [
    {
      id: "var-1",
      pancakeDisplayId: "ANH-FEEDBACK-01",
      pancakeImageUrls: [KNOWN_IMG_1.src, KNOWN_IMG_1.src, KNOWN_IMG_2.src],
    },
    {
      id: "var-2",
      pancakeDisplayId: "ANH-FEEDBACK-02",
      pancakeImageUrls: [KNOWN_IMG_2.src, KNOWN_IMG_1.src],
    },
  ];

  const images = mapFeedbackVariantsToImages(variants);
  assert.equal(images.length, 2);
  assert.deepEqual(
    images.map((image) => image.src),
    [KNOWN_IMG_1.src, KNOWN_IMG_2.src],
  );
});

test("mapFeedbackVariantsToImages preserves calibrated natural dimensions", () => {
  const variants: FeedbackVariantRow[] = [
    {
      id: "var-1",
      pancakeDisplayId: "ANH-FEEDBACK-01",
      pancakeImageUrls: [KNOWN_IMG_1.src],
    },
  ];

  const images = mapFeedbackVariantsToImages(variants);
  assert.equal(images.length, 1);
  assert.equal(images[0]?.src, KNOWN_IMG_1.src);
  assert.equal(images[0]?.width, KNOWN_IMG_1.width);
  assert.equal(images[0]?.height, KNOWN_IMG_1.height);
});

test("mapFeedbackVariantsToImages fails closed instead of inventing dimensions for a new image", () => {
  const variants: FeedbackVariantRow[] = [
    {
      id: "var-1",
      pancakeDisplayId: "ANH-FEEDBACK-01",
      pancakeImageUrls: [NEW_IMG_URL],
    },
  ];

  const images = mapFeedbackVariantsToImages(variants);
  assert.deepEqual(images, []);
});

test("mapFeedbackVariantsToImages filters untrusted or invalid URLs", () => {
  const variants: FeedbackVariantRow[] = [
    {
      id: "var-1",
      pancakeDisplayId: "ANH-FEEDBACK-01",
      pancakeImageUrls: [
        "https://evil.example.com/malicious.jpg",
        "http://content.pancake.vn/insecure.jpg",
        "not-a-valid-url",
        KNOWN_IMG_1.src,
      ],
    },
  ];

  const images = mapFeedbackVariantsToImages(variants);
  assert.equal(images.length, 1);
  assert.equal(images[0]?.src, KNOWN_IMG_1.src);
});

test("createFeedbackRepository scopes reads to configured shop and exact ANH-FEEDBACK- prefix", async () => {
  let capturedArgs: unknown = null;
  const mockClient: FeedbackReadClient = {
    variantMirror: {
      async findMany(args) {
        capturedArgs = args;
        return [
          {
            id: "var-1",
            pancakeDisplayId: "ANH-FEEDBACK-01",
            pancakeImageUrls: [KNOWN_IMG_1.src],
          },
        ];
      },
    },
  };

  const repository = createFeedbackRepository(mockClient);
  const images = await repository.listFeedbackImages({ shopId: 123 });

  assert.equal(images.length, 1);
  assert.equal(images[0]?.src, KNOWN_IMG_1.src);
  assert.ok(capturedArgs !== null);

  const where = (
    capturedArgs as {
      where: {
        isPresent: boolean;
        pancakeDisplayId: { startsWith: string };
        product: { pancakeShopId: number };
        OR?: unknown;
      };
    }
  ).where;

  assert.equal(where.isPresent, true);
  assert.equal(where.pancakeDisplayId.startsWith, "ANH-FEEDBACK-");
  assert.equal(where.product.pancakeShopId, 123);
  assert.equal(where.OR, undefined);
});

test("resolveFeedbackContentWithImages joins images with config copy", () => {
  const content = resolveFeedbackContentWithImages([
    { src: KNOWN_IMG_1.src, alt: "", width: KNOWN_IMG_1.width, height: KNOWN_IMG_1.height },
  ]);

  assert.notEqual(content, null);
  assert.equal(content?.title, HOMEPAGE_CONFIG.feedback.title);
  assert.equal(content?.ctaLabel, HOMEPAGE_CONFIG.feedback.ctaLabel);
  assert.equal(content?.metadataTitle, HOMEPAGE_CONFIG.feedback.metadataTitle);
  assert.equal(content?.metadataDescription, HOMEPAGE_CONFIG.feedback.metadataDescription);
  assert.equal(content?.images.length, 1);
  assert.equal(content?.images[0]?.src, KNOWN_IMG_1.src);
});

test("readDynamicFeedbackContent fails closed if the mirror cannot be read", async () => {
  const failingClient: FeedbackReadClient = {
    variantMirror: {
      async findMany() {
        throw new Error("Database connection timed out");
      },
    },
  };

  const content = await readDynamicFeedbackContent({ client: failingClient, shopId: 123 });
  assert.equal(content, null);
});
