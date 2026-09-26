import assert from "node:assert/strict";
import test from "node:test";

import {
  BRAND,
  MARKET_VN,
  NAVIGATION,
  SIZE_GUIDE,
  loadBrandConfig,
  type BrandConfig,
  type NavigationConfig,
  type SizeGuideConfig,
} from "../../src/brand/index.ts";
import { normalizeVietnamesePhone } from "../../src/integrations/meta/conversions-api.ts";

function withBrand(mutate: (draft: BrandConfig) => BrandConfig) {
  return () => loadBrandConfig(mutate(structuredClone(BRAND) as BrandConfig));
}

function withSizeGuide(mutate: (draft: SizeGuideConfig) => SizeGuideConfig) {
  return () =>
    loadBrandConfig(BRAND, mutate(structuredClone(SIZE_GUIDE) as SizeGuideConfig), NAVIGATION);
}

function withNavigation(mutate: (draft: NavigationConfig) => NavigationConfig) {
  return () =>
    loadBrandConfig(BRAND, SIZE_GUIDE, mutate(structuredClone(NAVIGATION) as NavigationConfig));
}

test("the committed brand config loads", () => {
  const loaded = loadBrandConfig();
  assert.equal(loaded.brand, BRAND);
  assert.equal(loaded.sizeGuide, SIZE_GUIDE);
  assert.equal(loaded.navigation, NAVIGATION);
});

test("the market is locked to Vietnam and VND", () => {
  assert.deepEqual(MARKET_VN, { language: "vi", country: "VN", currency: "VND" });
  assert.ok(Object.isFrozen(MARKET_VN));
  assert.equal(BRAND.market, MARKET_VN);

  assert.throws(
    withBrand((draft) => ({
      ...draft,
      // Only reachable through a cast; the Market type makes any other currency uncompilable.
      market: { language: "vi", country: "VN", currency: "USD" } as unknown as typeof MARKET_VN,
    })),
    /Vietnam and VND only/,
  );
});

test("every required identity fact must be present", () => {
  for (const field of [
    "name",
    "displayNameUpper",
    "legalName",
    "taxId",
    "positioning",
    "socialCardSlug",
    "socialCardAlt",
  ] as const) {
    for (const blank of ["", "   "]) {
      assert.throws(
        withBrand((draft) => ({ ...draft, identity: { ...draft.identity, [field]: blank } })),
        new RegExp(`identity.${field}`),
        `blank ${field} must fail closed`,
      );
    }
  }
});

test("positioning has to stay one sentence", () => {
  assert.throws(
    withBrand((draft) => ({
      ...draft,
      identity: {
        ...draft.identity,
        positioning: "Thương hiệu tối giản. Được thành lập năm 2019 bởi hai người bạn.",
      },
    })),
    /exactly one sentence/,
  );
});

test("the social card slug must be a route directory slug", () => {
  for (const slug of ["LA-Clothing", "la clothing", "/la-clothing", "la_clothing"]) {
    assert.throws(
      withBrand((draft) => ({ ...draft, identity: { ...draft.identity, socialCardSlug: slug } })),
      /socialCardSlug/,
      `${slug} must fail closed`,
    );
  }
});

test("the international phone spelling must derive from the approved number", () => {
  assert.equal(
    BRAND.contact.telephoneInternational,
    `+${normalizeVietnamesePhone(BRAND.contact.telephone)}`,
  );

  assert.throws(
    withBrand((draft) => ({
      ...draft,
      // One subscriber digit changed: a typo that a hand-written second spelling would hide.
      contact: { ...draft.contact, telephoneInternational: "+84923159777" },
    })),
    /international spelling/,
  );
});

test("contact email and fanpage must be well formed", () => {
  for (const email of ["laclothing2025", "la clothing@example.com", "a@b"]) {
    assert.throws(
      withBrand((draft) => ({ ...draft, contact: { ...draft.contact, email } })),
      /contact.email/,
      `${email} must fail closed`,
    );
  }
  for (const fanpageUrl of ["facebook.com/LAclothing.vn", "http://www.facebook.com/LAclothing.vn"]) {
    assert.throws(
      withBrand((draft) => ({ ...draft, contact: { ...draft.contact, fanpageUrl } })),
      /contact.fanpageUrl/,
      `${fanpageUrl} must fail closed`,
    );
  }
  // The optional social profiles are held to the same bar, plus the network they claim to be.
  for (const [field, url] of [
    ["instagramUrl", "instagram.com/lana"],
    ["instagramUrl", "http://www.instagram.com/lana"],
    ["instagramUrl", "https://www.tiktok.com/@lana"],
    ["tiktokUrl", "https://www.instagram.com/lana"],
    ["messengerUrl", "http://m.me/lana"],
    ["messengerUrl", "https://www.facebook.com/lana"],
  ] as const) {
    assert.throws(
      withBrand((draft) => ({ ...draft, contact: { ...draft.contact, [field]: url } })),
      new RegExp(`contact.${field}`),
      `${field} ${url} must fail closed`,
    );
  }
  for (const [field, url] of [
    ["instagramUrl", "https://www.instagram.com/lana"],
    ["tiktokUrl", "https://www.tiktok.com/@lana"],
    ["messengerUrl", "https://m.me/lana"],
  ] as const) {
    assert.doesNotThrow(
      withBrand((draft) => ({ ...draft, contact: { ...draft.contact, [field]: url } })),
      `${field} ${url} is a valid profile`,
    );
  }
});

test("support hours must keep the shape both consumers read", () => {
  assert.throws(
    withBrand((draft) => ({
      ...draft,
      contact: { ...draft.contact, supportHours: { ...draft.contact.supportHours, opens: "8:00" } },
    })),
    /supportHours.opens must be HH:MM/,
  );
  assert.throws(
    withBrand((draft) => ({
      ...draft,
      contact: {
        ...draft.contact,
        supportHours: { ...draft.contact.supportHours, utcOffset: "UTC+7" },
      },
    })),
    /utcOffset must be an ISO 8601 offset/,
  );
  assert.throws(
    withBrand((draft) => ({
      ...draft,
      contact: { ...draft.contact, supportHours: { ...draft.contact.supportHours, days: [] } },
    })),
    /supportHours.days/,
  );
});

test("merchant defaults must be Google Merchant controlled values", () => {
  assert.throws(
    withBrand((draft) => ({
      ...draft,
      merchant: { ...draft.merchant, defaultGender: "mens" as never },
    })),
    /defaultGender/,
  );
  assert.throws(
    withBrand((draft) => ({
      ...draft,
      merchant: { ...draft.merchant, defaultAgeGroup: "grown-up" as never },
    })),
    /defaultAgeGroup/,
  );
  assert.throws(
    withBrand((draft) => ({ ...draft, merchant: { ...draft.merchant, feedBrand: "  " } })),
    /merchant.feedBrand/,
  );
});

test("the size guide supports one chart or many", () => {
  assert.ok(SIZE_GUIDE.charts.length >= 1);
  const single = withSizeGuide((draft) => ({ ...draft, charts: [draft.charts[0]!] }));
  assert.doesNotThrow(single);

  assert.throws(withSizeGuide((draft) => ({ ...draft, charts: [] })), /at least one chart/);
});

test("a size chart row must carry exactly the chart's size keys", () => {
  const chartId = SIZE_GUIDE.charts[0]!.id;

  // A missing size key: the page would render a blank cell.
  assert.throws(
    withSizeGuide((draft) => {
      const chart = draft.charts[0]!;
      const row = chart.rows[0]!;
      const { M: _dropped, ...rest } = row.values as Record<string, string>;
      return {
        ...draft,
        charts: [{ ...chart, rows: [{ ...row, values: rest }, ...chart.rows.slice(1)] }],
      };
    }),
    new RegExp(`chart "${chartId}"`),
  );

  // A stray size key the chart never declared.
  assert.throws(
    withSizeGuide((draft) => {
      const chart = draft.charts[0]!;
      const row = chart.rows[0]!;
      return {
        ...draft,
        charts: [
          {
            ...chart,
            rows: [{ ...row, values: { ...row.values, "3XL": "122" } }, ...chart.rows.slice(1)],
          },
        ],
      };
    }),
    new RegExp(`chart "${chartId}"`),
  );

  // A blank measurement.
  assert.throws(
    withSizeGuide((draft) => {
      const chart = draft.charts[0]!;
      const row = chart.rows[0]!;
      return {
        ...draft,
        charts: [
          { ...chart, rows: [{ ...row, values: { ...row.values, M: "" } }, ...chart.rows.slice(1)] },
        ],
      };
    }),
    new RegExp(`chart "${chartId}"`),
  );
});

test("size chart ids must be unique", () => {
  assert.throws(
    withSizeGuide((draft) => ({ ...draft, charts: [draft.charts[0]!, draft.charts[0]!] })),
    /is duplicated/,
  );
});

test("each chart may declare its own size scale", () => {
  assert.doesNotThrow(
    withSizeGuide((draft) => ({
      ...draft,
      charts: [
        draft.charts[0]!,
        {
          id: "trousers-waist",
          title: "Quần dài",
          sizes: ["28", "30", "32"],
          rows: [{ parameter: "Vòng eo (cm)", values: { "28": "71", "30": "76", "32": "81" } }],
        },
      ],
    })),
  );
});

test("navigation links must be site-relative, labelled and unique", () => {
  // Every spelling that can leave the origin. "//evil.example/path" is the one that matters: it
  // starts with a slash, so a naive startsWith("/") check lets it through, and the browser then
  // resolves it as an absolute URL on the attacker's host.
  for (const href of [
    "https://example.com",
    "//evil.example/path",
    "//evil.example",
    "/\\evil.example/path",
    "http://evil.example",
    "javascript:alert(1)",
    "mailto:a@b.test",
    "shop",
  ]) {
    assert.throws(
      withNavigation((draft) => ({ ...draft, primary: [...draft.primary, { href, label: "Ngoài" }] })),
      /site-relative/,
      `${href} must be rejected as a navigation target`,
    );
  }

  // Ordinary same-origin paths still pass.
  for (const href of ["/shop", "/shop/ao-thun", "/shop?page=2"]) {
    assert.doesNotThrow(
      withNavigation((draft) => ({ ...draft, primary: [{ href, label: "Mục" }] })),
      `${href} must be accepted`,
    );
  }
  assert.throws(
    withNavigation((draft) => ({ ...draft, primary: [...draft.primary, draft.primary[0]!] })),
    /repeats/,
  );
  assert.throws(
    withNavigation((draft) => ({ ...draft, primary: [{ href: "/shop", label: " " }] })),
    /link label/,
  );
  assert.throws(withNavigation((draft) => ({ ...draft, footer: [] })), /at least one link/);
});
