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
      {
        src: "https://content.pancake.vn/2-2603/2026/3/26/65f4ed1dd3c330c26fca01aaf4d2740f24c5ddaa.jpg",
        alt: "",
        width: 902,
        height: 1280,
      },
      {
        src: "https://content.pancake.vn/2-2609/2026/9/29/1ebfbb2da4b5139bf9936e1629d9d47daad22bc9.jpg",
        alt: "",
        width: 720,
        height: 1280,
      },
      {
        src: "https://content.pancake.vn/2-2609/2026/9/29/5cb4cd8121e707440e465f54297501296f84451c.jpg",
        alt: "",
        width: 1366,
        height: 2048,
      },
      {
        src: "https://content.pancake.vn/2-2512/2025/12/31/fd0783fd238a8aef64259fce247b11cd48b5f55a.jpg",
        alt: "",
        width: 1575,
        height: 1575,
      },
      {
        src: "https://content.pancake.vn/2-2609/2026/9/29/a0542865424bacd573019f8ba1ff183325d0bde1.jpg",
        alt: "",
        width: 1366,
        height: 2048,
      },
      {
        src: "https://content.pancake.vn/2-2609/2026/9/29/604173589fc23e6a83bfa5665c0a60be3aed1099.jpg",
        alt: "",
        width: 1366,
        height: 2048,
      },
      {
        src: "https://content.pancake.vn/2-2603/2026/3/26/0f57d5977bcd35425231937762cf137579c90865.jpg",
        alt: "",
        width: 1200,
        height: 1800,
      },
      {
        src: "https://content.pancake.vn/2-2609/2026/9/29/1ad1360eb81788e5bfb13355f50f0d90c05f4632.jpg",
        alt: "",
        width: 1200,
        height: 1800,
      },
      {
        src: "https://content.pancake.vn/2-2609/2026/9/29/84b861fef9da4624eda9ddda00f051a7ae28152e.jpg",
        alt: "",
        width: 1080,
        height: 1620,
      },
      {
        src: "https://content.pancake.vn/2-2609/2026/9/29/d704f5a9c31d3074e48b40df3a7185f5684c59f8.jpg",
        alt: "",
        width: 1200,
        height: 1800,
      },
      {
        src: "https://content.pancake.vn/2-2603/2026/3/26/c24f987ef3ce117b33d93db28837508cc6912a7c.jpg",
        alt: "",
        width: 1290,
        height: 1913,
      },
      {
        src: "https://content.pancake.vn/2-2603/2026/3/26/b03423d9fdebad6a53e827c719aa3c3f9056586a.jpg",
        alt: "",
        width: 1283,
        height: 1927,
      },
      {
        src: "https://content.pancake.vn/2-2609/2026/9/29/b30684c6a165b0990a8794597a5595d0e6bfb361.jpg",
        alt: "",
        width: 1080,
        height: 1624,
      },
      {
        src: "https://content.pancake.vn/2-2609/2026/9/29/373fc07d029ea3a7eae4f7c9f26512350431c3a6.jpg",
        alt: "",
        width: 1200,
        height: 1801,
      },
      {
        src: "https://content.pancake.vn/2-2609/2026/9/29/31483463b0e0cf8a63873f8162199cb0800021fb.jpg",
        alt: "",
        width: 1080,
        height: 1624,
      },
      {
        src: "https://content.pancake.vn/2-2609/2026/9/29/41dbfd1522ba8972ebf178c241d3c7eb32490ce2.jpg",
        alt: "",
        width: 1366,
        height: 2048,
      },
      {
        src: "https://content.pancake.vn/2-2609/2026/9/29/9ea6927ca4d636f0131bb0efa149d0239069f265.jpg",
        alt: "",
        width: 1366,
        height: 2048,
      },
      {
        src: "https://content.pancake.vn/2-2610/2026/10/2/1c1d501a7ff30a7ee113887c7051dcc487f3f80a.jpg",
        alt: "",
        width: 1366,
        height: 2048,
      },
      {
        src: "https://content.pancake.vn/2-2610/2026/10/2/eff19dc55f59d2a312ed3cb7353d4bb2bbfa8696.jpg",
        alt: "",
        width: 1366,
        height: 2048,
      },
      {
        src: "https://content.pancake.vn/2-2610/2026/10/2/aa3825090322f2025e549e19a6b17cb473f1c938.jpg",
        alt: "",
        width: 1536,
        height: 2048,
      },
      {
        src: "https://content.pancake.vn/2-2610/2026/10/2/ef308a99a4c64c5ede8389c936f57cc42359a9d4.jpg",
        alt: "",
        width: 1536,
        height: 2048,
      },
      {
        src: "https://content.pancake.vn/2-2610/2026/10/2/5de8035aa71bf0898f8886175545c5a7c1e6f314.jpg",
        alt: "",
        width: 1536,
        height: 2048,
      },
      {
        src: "https://content.pancake.vn/2-2610/2026/10/2/1b3de800f811c9529c7cb497a1da0f911e46fb7a.jpg",
        alt: "",
        width: 1536,
        height: 2048,
      },
      {
        src: "https://content.pancake.vn/2-2610/2026/10/2/6be209b99bcb2eb957cd2e8e80b978dd5d01c6c4.jpg",
        alt: "",
        width: 2048,
        height: 1411,
      },
      {
        src: "https://content.pancake.vn/2-2610/2026/10/2/eb3d326c014916256a7a83d86759447f40a5da57.jpg",
        alt: "",
        width: 1500,
        height: 2048,
      },
      {
        src: "https://content.pancake.vn/2-2610/2026/10/2/9fb71094a58955a89495e2b58ac27d3379218ede.jpg",
        alt: "",
        width: 1536,
        height: 2048,
      },
      {
        src: "https://content.pancake.vn/2-2610/2026/10/2/102898520a6ef42354d942522ad08978db2c07e8.jpg",
        alt: "",
        width: 2048,
        height: 1366,
      },
      {
        src: "https://content.pancake.vn/2-2610/2026/10/2/0ef820d9ba575a028447c11f93d2a3debc4d48fe.jpg",
        alt: "",
        width: 1536,
        height: 2048,
      },
      {
        src: "https://content.pancake.vn/2-2610/2026/10/2/32a9a6f05dd6d6559cf0d664c4d9b4984cb2599a.jpg",
        alt: "",
        width: 1536,
        height: 2048,
      },
      {
        src: "https://content.pancake.vn/2-2610/2026/10/2/e5b9be48dadca30fcebbf3bc17f0300862494170.jpg",
        alt: "",
        width: 1536,
        height: 2048,
      },
      {
        src: "https://content.pancake.vn/2-2610/2026/10/2/07c876b96a327ac966452e8ee095b06a00af43f3.jpg",
        alt: "",
        width: 1536,
        height: 2048,
      },
      {
        src: "https://content.pancake.vn/2-2610/2026/10/2/b661ecaa7566533a1aa9cc420b19be94950d6a87.jpg",
        alt: "",
        width: 1536,
        height: 2048,
      },
      {
        src: "https://content.pancake.vn/2-2610/2026/10/2/a8979831a0f0cdceb3553d34cf9c587d61f0d3fb.jpg",
        alt: "",
        width: 1345,
        height: 2048,
      },
      {
        src: "https://content.pancake.vn/2-2610/2026/10/2/795e544a7cbd72edec4ef1f0fb5e017078e1675a.jpg",
        alt: "",
        width: 1497,
        height: 2048,
      },
      {
        src: "https://content.pancake.vn/2-2610/2026/10/2/d2b9a518bfe561223c092d38f5318ca7d9dcd75d.jpg",
        alt: "",
        width: 698,
        height: 960,
      },
      {
        src: "https://content.pancake.vn/2-2610/2026/10/2/24d34279d1923cda90b2082491ea12d3e427437a.jpg",
        alt: "",
        width: 2048,
        height: 1830,
      },
      {
        src: "https://content.pancake.vn/2-2610/2026/10/2/9218a084ce6877234f28c613f6133220bf8f485b.jpg",
        alt: "",
        width: 1364,
        height: 2048,
      },
      {
        src: "https://content.pancake.vn/2-2610/2026/10/2/8a1466eb1e60f11e343e3697b88a7603d998bb72.jpg",
        alt: "",
        width: 1470,
        height: 2048,
      },
      {
        src: "https://content.pancake.vn/2-2610/2026/10/2/051dc8d270e6a3aed3ebddd6c7640575c542e0d7.jpg",
        alt: "",
        width: 1366,
        height: 2048,
      },
      {
        src: "https://content.pancake.vn/2-2610/2026/10/2/cd94b7c261b0e07ca15793212246820676c68f14.jpg",
        alt: "",
        width: 1490,
        height: 2048,
      },
      {
        src: "https://content.pancake.vn/2-2610/2026/10/2/c521cb663a5793a8643b57ed56b63c0fa62f5d13.jpg",
        alt: "",
        width: 1536,
        height: 2048,
      },
      {
        src: "https://content.pancake.vn/2-2610/2026/10/2/b7a37650881050770c546e48240f43c08dbcbc4c.jpg",
        alt: "",
        width: 1578,
        height: 2048,
      },
      {
        src: "https://content.pancake.vn/2-2610/2026/10/2/dcf969bf5dfa87d402ad4072a5e195b6f3360b6d.jpg",
        alt: "",
        width: 1366,
        height: 2048,
      },
      {
        src: "https://content.pancake.vn/2-2610/2026/10/2/118996b8e12da992d842c2353c1971f51c10c237.jpg",
        alt: "",
        width: 1366,
        height: 2048,
      },
      {
        src: "https://content.pancake.vn/2-2610/2026/10/2/0dccf07c850e6c6234a944dc1740fea46db0b4ad.jpg",
        alt: "",
        width: 718,
        height: 960,
      },
      {
        src: "https://content.pancake.vn/2-2610/2026/10/2/2bc731a63f761dafe268902dcc942a2c6fcb7e29.jpg",
        alt: "",
        width: 1366,
        height: 2048,
      },
      {
        src: "https://content.pancake.vn/2-2610/2026/10/2/c908f92255c7293bdd8dc3182122b01d1fbe5628.jpg",
        alt: "",
        width: 960,
        height: 1280,
      },
      {
        src: "https://content.pancake.vn/2-2610/2026/10/2/9244f79f41d9e5105a54a25ccb2efdf1d00fdb74.jpg",
        alt: "",
        width: 1366,
        height: 2048,
      },
      {
        src: "https://content.pancake.vn/2-2610/2026/10/2/dd13f91ecec1495ba253bd12d03db7409cf1e5bc.jpg",
        alt: "",
        width: 1493,
        height: 1991,
      },
      {
        src: "https://content.pancake.vn/2-2610/2026/10/2/79d2e0d78d768aac662d85c92295ce53b5f66720.jpg",
        alt: "",
        width: 2048,
        height: 1366,
      },
      {
        src: "https://content.pancake.vn/2-2610/2026/10/2/ca388528c8cca4f3899b15cdb4ec324758b78415.jpg",
        alt: "",
        width: 1536,
        height: 2048,
      },
    ],
  },
};
