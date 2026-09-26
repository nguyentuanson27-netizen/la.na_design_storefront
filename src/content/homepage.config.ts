/**
 * Homepage editorial refresh — the repository-owned content the approved spec leaves to config.
 *
 * Authority: `docs/specs/homepage-editorial-refresh.md` §8. This file owns **only** values that
 * have no canonical owner elsewhere, and deliberately holds nothing that does:
 *
 * - no manual SPECIAL DEALS product list — that is `HomepageFeaturedProduct`;
 * - no category images — those are `CategoryEditorialMedia.heroImageUrl`;
 * - no category labels or hrefs — those are `CATEGORY_NAVIGATION`;
 * - no promo titles — the visible name of a promo tile is its collection's `CollectionDefinition.title`.
 *
 * Every value the owner has not supplied yet is `null` (or an empty list), and the section that
 * needs it omits itself. §17 of the spec lists these as pending content, not missing requirements:
 * nothing here may be filled with invented copy, collections or photography to make a screenshot
 * look complete. Validation happens at one boundary, `homepage-content.ts`, not in the page.
 */

/** One collection promo tile. The visible title is derived from the collection, never stored here. */
export type CollectionPromoSlotConfig = Readonly<{
  collectionSlug: string;
  /** A stable local `/public` path, or a URL that passes the trusted product-media contract. */
  imageSrc: string;
  ctaLabel: string;
}>;

/** A promo row is exactly two slots. A `null` slot is unmapped, and an unmapped slot omits its row. */
export type CollectionPromoRowConfig = readonly [
  CollectionPromoSlotConfig | null,
  CollectionPromoSlotConfig | null,
];

export type FeedbackImageConfig = Readonly<{
  /** A stable local `/public` path, or a URL that passes the trusted product-media contract. */
  src: string;
  /**
   * A manually authored accessibility decision: descriptive text when the photo is informative, or
   * an explicit `""` when it is purely decorative. Never generated.
   */
  alt: string;
  /**
   * Natural pixel size of the asset. Required: `/feedback` is an uncropped masonry, and these are
   * what let each tile reserve its photograph's own ratio before it loads.
   */
  width: number;
  height: number;
}>;

export type HomepageConfig = Readonly<{
  /**
   * Only what genuinely varies. The section's role and its `SPECIAL DEALS` title are fixed by the
   * spec (§7.2) and live in code (`SPECIAL_DEALS_TITLE`), so a config edit cannot redefine them.
   */
  specialDeals: Readonly<{
    supportingCopy: string | null;
    /** The one collection that supplies the fallback products and the `Xem thêm` destination. */
    sourceCollectionSlug: string | null;
    ctaLabel: string;
  }>;
  /** Row A sits before YOUR NEXT FAVOURITE, row B after it. Same component, same schema. */
  promoRows: readonly [CollectionPromoRowConfig, CollectionPromoRowConfig];
  categoryDiscovery: Readonly<{
    title: string;
    description: string | null;
  }>;
  feedback: Readonly<{
    /** Section heading on the homepage and the `/feedback` page heading. */
    title: string | null;
    ctaLabel: string;
    metadataTitle: string | null;
    metadataDescription: string | null;
    /** Manually selected and ordered. The homepage rail and `/feedback` show them in this order. */
    images: readonly FeedbackImageConfig[];
  }>;
}>;

export const HOMEPAGE_CONFIG: HomepageConfig = {
  specialDeals: {
    supportingCopy: "Ưu đãi chọn lọc số lượng có hạn",
    sourceCollectionSlug: "special-deals",
    ctaLabel: "Xem thêm",
  },
  promoRows: [
    [
      {
        collectionSlug: "diep-hoa-thu",
        imageSrc:
          "https://content.pancake.vn/2-2609/2026/9/25/eca187739867ee35b0cfab095536ca21dadbb912.webp",
        ctaLabel: "Khám phá",
      },
      {
        collectionSlug: "xuan-hoai-ky",
        imageSrc:
          "https://content.pancake.vn/2-2609/2026/9/25/784469b3dcc73a72722578bce36b4ceb1fa595c2.webp",
        ctaLabel: "Khám phá",
      },
    ],
    [
      {
        collectionSlug: "lap-thu",
        imageSrc:
          "https://content.pancake.vn/2-2609/2026/9/25/a0c855bd26522c80e3869b16b95261c13ec93351.webp",
        ctaLabel: "Khám phá",
      },
      {
        collectionSlug: "lien-sac",
        imageSrc:
          "https://content.pancake.vn/2-2609/2026/9/26/d14e78279e2ef73cffc3c36fced4d10f1af5f387.webp",
        ctaLabel: "Khám phá",
      },
    ],
  ],
  categoryDiscovery: {
    title: "YOUR NEXT FAVOURITE",
    description: "You might’ve just found it",
  },
  feedback: {
    title: "Khách hàng & La.na",
    ctaLabel: "Xem thêm",
    metadataTitle: "Khách hàng & La.na | Feedback",
    metadataDescription: "Khoảnh khắc và hình ảnh chân thực từ khách hàng diện trang phục thiết kế La.na.",
    images: [
      {
        src: "https://content.pancake.vn/2-2609/2026/9/24/50303d94ca82d0864a052e852cad505f680b677c.jpg",
        alt: "",
        width: 1366,
        height: 2048,
      },
      {
        src: "https://content.pancake.vn/2-2609/2026/9/24/7f7fc0a42d8f871e03178c925dc41c8ab410ca8d.jpg",
        alt: "",
        width: 1366,
        height: 2048,
      },
      {
        src: "https://content.pancake.vn/2-2609/2026/9/24/0482e2366ff22c77839d2aff57075721de566bd4.jpg",
        alt: "",
        width: 1200,
        height: 2032,
      },
      {
        src: "https://content.pancake.vn/2-2609/2026/9/24/39146073a069e00dcdaa8f1666eaf7850fb6a07e.jpg",
        alt: "",
        width: 1366,
        height: 2048,
      },
      {
        src: "https://content.pancake.vn/2-2609/2026/9/24/48a25a20f7fd2d23835efe0db2374da69b476ec5.webp",
        alt: "",
        width: 1200,
        height: 2134,
      },
      {
        src: "https://content.pancake.vn/2-2609/2026/9/24/0f9dff8d0092920a05656931020915749d709303.jpg",
        alt: "",
        width: 1080,
        height: 1620,
      },
      {
        src: "https://content.pancake.vn/2-2609/2026/9/24/23e25fb5e9d10f8bdcc1bd5e3bc9d7df8d55a300.jpg",
        alt: "",
        width: 1366,
        height: 2048,
      },
      {
        src: "https://content.pancake.vn/2-2609/2026/9/24/c4ce4fc42b9d4291b9f247a9fca4d600404a7097.webp",
        alt: "",
        width: 1200,
        height: 2135,
      },
      {
        src: "https://content.pancake.vn/2-2609/2026/9/24/697f9c397a5bea785f4b719e2c369303dc4946ce.jpg",
        alt: "",
        width: 1366,
        height: 2048,
      },
      {
        src: "https://content.pancake.vn/2-2609/2026/9/24/1d9b0a6653f4e898156316b0f0505b1ddcca9e89.jpg",
        alt: "",
        width: 1344,
        height: 2048,
      },
      {
        src: "https://content.pancake.vn/2-2609/2026/9/24/2a580669b5d3c984822fde1da6c025f8e9a9ead4.jpg",
        alt: "",
        width: 1366,
        height: 2048,
      },
      {
        src: "https://content.pancake.vn/2-2609/2026/9/24/d544bac50d4be7642e53ee898e53fcd7a1b4fad1.jpg",
        alt: "",
        width: 858,
        height: 1280,
      },
      {
        src: "https://content.pancake.vn/2-2609/2026/9/24/599d3b31e4de721b84060b34f1c96c7c73a7fbe0.jpg",
        alt: "",
        width: 1326,
        height: 2048,
      },
      {
        src: "https://content.pancake.vn/2-2609/2026/9/24/e2ce2622086b72481325874ae1a62a690ceb7a11.jpg",
        alt: "",
        width: 960,
        height: 1280,
      },
      {
        src: "https://content.pancake.vn/2-2609/2026/9/24/3e1f6c6729a8c525737962d7de93432146bb09eb.jpg",
        alt: "",
        width: 1080,
        height: 1620,
      },
      {
        src: "https://content.pancake.vn/2-2609/2026/9/24/cdffb31918ee6b4a934735c51b2272a3ad258181.jpg",
        alt: "",
        width: 1080,
        height: 1620,
      },
      {
        src: "https://content.pancake.vn/2-2609/2026/9/24/fba0687d609053a9f4bd44efeb81eecb1f795f54.jpg",
        alt: "",
        width: 960,
        height: 1280,
      },
      {
        src: "https://content.pancake.vn/2-2609/2026/9/24/e356629f54f18b6e1af99fb5853dd82c9ed557af.jpg",
        alt: "",
        width: 1440,
        height: 1860,
      },
      {
        src: "https://content.pancake.vn/2-2609/2026/9/24/dc17cfbc3fc42a35342203f01befcd7dcb094e19.webp",
        alt: "",
        width: 2560,
        height: 1707,
      },
      {
        src: "https://content.pancake.vn/2-2609/2026/9/24/db1205aac4224244522f0bfc7cb5d3e70bec615b.jpg",
        alt: "",
        width: 2560,
        height: 1707,
      },
      {
        src: "https://content.pancake.vn/2-2609/2026/9/24/856b193b0200a1543a721f8433605f833922c357.webp",
        alt: "",
        width: 4000,
        height: 6000,
      },
      {
        src: "https://content.pancake.vn/2-2609/2026/9/24/137800b01ec39bd9fa68b8c5f81f252f714bc43b.webp",
        alt: "",
        width: 3956,
        height: 5934,
      },
      {
        src: "https://content.pancake.vn/2-2609/2026/9/24/cf3831c0082f3890a684f94c618bd1732a30bc83.jpg",
        alt: "",
        width: 2160,
        height: 3238,
      },
      {
        src: "https://content.pancake.vn/2-2609/2026/9/24/c6dd93dd9902f9a3afbae018a2a9664077f41eaa.jpg",
        alt: "",
        width: 2160,
        height: 3238,
      },
      {
        src: "https://content.pancake.vn/2-2601/2026/1/25/e678a8065634f2dc0d1b3f44218784f1e5439b47.jpg",
        alt: "",
        width: 1200,
        height: 2134,
      },
      {
        src: "https://content.pancake.vn/2-2609/2026/9/24/c715600c68c47727c349abe035e9f95829b4c33f.webp",
        alt: "",
        width: 912,
        height: 1280,
      },
      {
        src: "https://content.pancake.vn/2-2609/2026/9/24/345d4d711c23d87c7ab2e8bae94b4c856f73df0f.webp",
        alt: "",
        width: 836,
        height: 1280,
      },
    ],
  },
};
