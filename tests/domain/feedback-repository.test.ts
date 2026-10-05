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
  readFeedbackContent,
  resolveFeedbackContentWithImages,
} from "../../src/content/homepage-content.ts";
import { HOMEPAGE_CONFIG } from "../../src/content/homepage.config.ts";

const KNOWN_IMG_1 = HOMEPAGE_CONFIG.feedback.images[0]!;
const NEW_IMG_URL_1 = "https://content.pancake.vn/2-2610/2026/10/2/test-photo-new-01.jpg";
const NEW_IMG_URL_2 = "https://content.pancake.vn/2-2610/2026/10/2/test-photo-new-02.jpg";

test("mapFeedbackVariantsToImages falls back to static config when variants are empty", () => {
  const images = mapFeedbackVariantsToImages([]);
  assert.equal(images, HOMEPAGE_CONFIG.feedback.images);
});

test("mapFeedbackVariantsToImages naturally sorts variants by display ID / SKU", () => {
  const variants: FeedbackVariantRow[] = [
    {
      id: "var-2",
      pancakeDisplayId: "ANH-FEEDBACK-02",
      sku: "ANH-FEEDBACK-02",
      pancakeImageUrls: [NEW_IMG_URL_2],
    },
    {
      id: "var-1",
      pancakeDisplayId: "ANH-FEEDBACK-01",
      sku: "ANH-FEEDBACK-01",
      pancakeImageUrls: [NEW_IMG_URL_1],
    },
  ];

  const images = mapFeedbackVariantsToImages(variants);
  assert.equal(images.length, 2);
  assert.equal(images[0]?.src, NEW_IMG_URL_1);
  assert.equal(images[1]?.src, NEW_IMG_URL_2);
});

test("mapFeedbackVariantsToImages deduplicates repeated URLs across variants", () => {
  const variants: FeedbackVariantRow[] = [
    {
      id: "var-1",
      pancakeDisplayId: "ANH-FEEDBACK-01",
      sku: "ANH-FEEDBACK-01",
      pancakeImageUrls: [NEW_IMG_URL_1, NEW_IMG_URL_1, NEW_IMG_URL_2],
    },
    {
      id: "var-2",
      pancakeDisplayId: "ANH-FEEDBACK-02",
      sku: "ANH-FEEDBACK-02",
      pancakeImageUrls: [NEW_IMG_URL_2, NEW_IMG_URL_1],
    },
  ];

  const images = mapFeedbackVariantsToImages(variants);
  assert.equal(images.length, 2);
  assert.deepEqual(
    images.map((img) => img.src),
    [NEW_IMG_URL_1, NEW_IMG_URL_2],
  );
});

test("mapFeedbackVariantsToImages preserves known dimensions and applies 1536x2048 fallback for new images", () => {
  const variants: FeedbackVariantRow[] = [
    {
      id: "var-1",
      pancakeDisplayId: "ANH-FEEDBACK-01",
      sku: "ANH-FEEDBACK-01",
      pancakeImageUrls: [KNOWN_IMG_1.src, NEW_IMG_URL_1],
    },
  ];

  const images = mapFeedbackVariantsToImages(variants);
  assert.equal(images.length, 2);

  // Known image preserves calibrated width/height from config
  assert.equal(images[0]?.src, KNOWN_IMG_1.src);
  assert.equal(images[0]?.width, KNOWN_IMG_1.width);
  assert.equal(images[0]?.height, KNOWN_IMG_1.height);

  // Newly synced image receives standard portrait fallback
  assert.equal(images[1]?.src, NEW_IMG_URL_1);
  assert.equal(images[1]?.width, 1536);
  assert.equal(images[1]?.height, 2048);
  assert.equal(images[1]?.alt, "");
});

test("mapFeedbackVariantsToImages filters untrusted or invalid URLs", () => {
  const variants: FeedbackVariantRow[] = [
    {
      id: "var-1",
      pancakeDisplayId: "ANH-FEEDBACK-01",
      sku: null,
      pancakeImageUrls: [
        "https://evil.example.com/malicious.jpg",
        "http://content.pancake.vn/insecure.jpg",
        "not-a-valid-url",
        NEW_IMG_URL_1,
      ],
    },
  ];

  const images = mapFeedbackVariantsToImages(variants);
  assert.equal(images.length, 1);
  assert.equal(images[0]?.src, NEW_IMG_URL_1);
});

test("createFeedbackRepository queries VariantMirror with proper filters", async () => {
  let capturedArgs: unknown = null;
  const mockClient: FeedbackReadClient = {
    variantMirror: {
      async findMany(args) {
        capturedArgs = args;
        return [
          {
            id: "var-1",
            pancakeDisplayId: "ANH-FEEDBACK-01",
            sku: null,
            pancakeImageUrls: [NEW_IMG_URL_1],
          },
        ];
      },
    },
  };

  const repository = createFeedbackRepository(mockClient);
  const images = await repository.listFeedbackImages();

  assert.equal(images.length, 1);
  assert.equal(images[0]?.src, NEW_IMG_URL_1);
  assert.ok(capturedArgs !== null);
  const where = (capturedArgs as { where: { isPresent: boolean } }).where;
  assert.equal(where.isPresent, true);
});

test("resolveFeedbackContentWithImages joins images with config copy", () => {
  const content = resolveFeedbackContentWithImages([
    { src: NEW_IMG_URL_1, alt: "", width: 1536, height: 2048 },
  ]);

  assert.notEqual(content, null);
  assert.equal(content?.title, HOMEPAGE_CONFIG.feedback.title);
  assert.equal(content?.ctaLabel, HOMEPAGE_CONFIG.feedback.ctaLabel);
  assert.equal(content?.metadataTitle, HOMEPAGE_CONFIG.feedback.metadataTitle);
  assert.equal(content?.metadataDescription, HOMEPAGE_CONFIG.feedback.metadataDescription);
  assert.equal(content?.images.length, 1);
  assert.equal(content?.images[0]?.src, NEW_IMG_URL_1);
});

test("readDynamicFeedbackContent falls back to readFeedbackContent if client throws", async () => {
  const failingClient: FeedbackReadClient = {
    variantMirror: {
      async findMany() {
        throw new Error("Database connection timed out");
      },
    },
  };

  const content = await readDynamicFeedbackContent(failingClient);
  const staticContent = readFeedbackContent();

  assert.notEqual(content, null);
  assert.deepEqual(content?.title, staticContent?.title);
  assert.equal(content?.images.length, staticContent?.images.length);
});
