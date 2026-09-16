import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { BRAND, loadBrandConfig, type BrandConfig } from "../../src/brand/index.ts";
import { MERCHANT_SHOP_APPAREL_DEFAULTS } from "../../src/commerce/merchant-apparel-facts.ts";
import { MERCHANT_BRAND } from "../../src/commerce/merchant-offer-mapper.ts";
import { buildRootMetadata } from "../../src/seo/root-metadata.ts";
import { SITE_NAME, SOCIAL_FALLBACK_ALT } from "../../src/seo/social-identity.ts";
import { buildStaticPageMetadata } from "../../src/seo/static-page-metadata.ts";

/**
 * A3 — the public identity, contact and Merchant truth this storefront publishes is La.na Design's,
 * not the Brand #1 values the template was forked with.
 *
 * Existing in code is not approval. These assertions quote the approved master-spec §5, §6 and §7
 * values, so a Brand #1 string cannot survive by being the thing nobody looked at, and the approved
 * homepage title and meta description are pinned exactly rather than approximately.
 *
 * The home metadata module is checked through its source rather than by calling it: it resolves the
 * `@/` alias Next owns, which the domain runner does not. What can be executed is executed -- the
 * builder it delegates to, and the Brand Config fact it reads -- so the source check is only
 * standing in for the wiring between two things that are each tested directly.
 */

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const HOME_METADATA_SOURCE = readFileSync(`${REPO_ROOT}src/routes/metadata/home.ts`, "utf8");

function withBrand(mutate: (draft: BrandConfig) => BrandConfig) {
  return () => loadBrandConfig(mutate(structuredClone(BRAND) as BrandConfig));
}

test("A3 the public identity is the approved La.na Design truth", () => {
  assert.equal(BRAND.identity.name, "La.na Design");
  // The field name is inherited; the approved wordmark is deliberately not uppercase.
  assert.equal(BRAND.identity.displayNameUpper, "La.na Design");
  assert.equal(BRAND.identity.headline, "La.na Design - charismatic in every yard of cloth.");
  assert.equal(
    BRAND.identity.tagline,
    "Thời trang nữ thiết kế thanh lịch với áo dài, váy và set đồ",
  );
  assert.equal(BRAND.identity.strapline, "Charismatic in every yard of cloth.");
  assert.equal(
    BRAND.identity.positioning,
    "La.na Design là thương hiệu thời trang nữ thiết kế, tập trung vào áo dài, váy và set đồ với phong cách thanh lịch, nữ tính",
  );
  assert.equal(
    BRAND.identity.socialCardAlt,
    "La.na Design - Thời trang nữ thiết kế thanh lịch, nữ tính",
  );
  // Project identity, not a brand fact: it follows project.config.json and must not be re-branded.
  assert.equal(BRAND.identity.socialCardSlug, "la-na-design-social-card");
});

test("A3 `Lana Design` is a controlled search alias and never the display name", () => {
  assert.equal(BRAND.identity.searchAlias, "Lana Design");
  assert.notEqual(BRAND.identity.searchAlias, BRAND.identity.name);
  assert.notEqual(BRAND.identity.searchAlias, BRAND.identity.displayNameUpper);

  // Every surface that names the brand to a reader names the approved spelling.
  assert.equal(SITE_NAME, "La.na Design");
  assert.equal(BRAND.identity.headline.startsWith("La.na Design"), true);
  assert.equal(BRAND.identity.socialCardAlt.includes("Lana Design"), false);
  assert.equal(SOCIAL_FALLBACK_ALT.includes("Lana Design"), false);
});

test("A3 the loader refuses an alias that has become the display name", () => {
  for (const alias of [BRAND.identity.name, BRAND.identity.displayNameUpper]) {
    assert.throws(
      withBrand((draft) => ({ ...draft, identity: { ...draft.identity, searchAlias: alias } })),
      /searchAlias/,
      `${alias} must fail closed as an alias`,
    );
  }
});

test("A3 the approved homepage SEO copy and the alias must be present", () => {
  for (const field of ["homeTitle", "homeMetaDescription", "searchAlias"] as const) {
    for (const blank of ["", "   "]) {
      assert.throws(
        withBrand((draft) => ({ ...draft, identity: { ...draft.identity, [field]: blank } })),
        new RegExp(`identity.${field}`),
        `blank ${field} must fail closed`,
      );
    }
  }
});

test("A3 the approved support contact replaces the Brand #1 channels", () => {
  assert.equal(BRAND.contact.email, "la.nadesignsince2022@gmail.com");
  assert.equal(BRAND.contact.fanpageUrl, "https://www.facebook.com/la.nadesign.vn");
  // The hotline, the business address and the support hours were already the approved ones.
  assert.equal(BRAND.contact.telephone, "0923159666");
  assert.equal(BRAND.contact.telephoneInternational, "+84923159666");
  assert.equal(BRAND.contact.streetAddress, "212 Nguyễn Trãi, Đại Mỗ");
  assert.equal(BRAND.contact.addressLocality, "Hà Nội");
});

test("A3 the Merchant defaults are the approved women's-fashion defaults", () => {
  assert.deepEqual(BRAND.merchant, {
    feedBrand: "La.na Design",
    defaultGender: "female",
    defaultAgeGroup: "adult",
  });

  // The feed and the apparel resolver read Brand Config, so they move with it rather than holding
  // a second copy that can stay male after the brand changed.
  assert.equal(MERCHANT_BRAND, "La.na Design");
  assert.deepEqual(MERCHANT_SHOP_APPAREL_DEFAULTS, {
    gender: "female",
    ageGroup: "adult",
    condition: "new",
  });
});

test("A3 the approved homepage title and meta description are the ones Brand Config holds", () => {
  assert.equal(BRAND.identity.homeTitle, "La.na Design | Áo dài & Thời trang nữ thiết kế");
  assert.equal(
    BRAND.identity.homeMetaDescription,
    "La.na Design - thời trang nữ thiết kế với áo dài cách tân, áo dài Tết, áo dài cưới, áo dài 4 tà, áo dài 6 tà, váy, set đồ và phụ kiện.",
  );
});

test("A3 the home route binds that copy through the existing static-page builder", () => {
  // The wiring: the module reads the approved facts rather than restating them, and asks for an
  // absolute title. The approved title already carries the brand name, so passing it as a plain
  // string would let the root template append "— La.na Design" to it a second time.
  assert.match(HOME_METADATA_SOURCE, /buildStaticPageMetadata\(/);
  assert.match(HOME_METADATA_SOURCE, /absolute:\s*BRAND\.identity\.homeTitle/);
  assert.match(HOME_METADATA_SOURCE, /description:\s*BRAND\.identity\.homeMetaDescription/);

  // The builder's half, executed: an absolute title and a description survive untouched, and
  // binding approved copy is still not an indexing decision -- the canonical stays gated.
  const metadata = buildStaticPageMetadata({
    origin: "https://shop.example.com",
    indexingEnabled: false,
    pathname: "/",
    searchParams: {},
    title: { absolute: BRAND.identity.homeTitle },
    description: BRAND.identity.homeMetaDescription,
  });

  assert.deepEqual(metadata.title, { absolute: "La.na Design | Áo dài & Thời trang nữ thiết kế" });
  assert.equal(metadata.description, BRAND.identity.homeMetaDescription);
  assert.equal(metadata.alternates, undefined);
});

test("A3 the site default title and description carry the approved brand line", () => {
  const metadata = buildRootMetadata({ origin: "https://shop.example.com", indexingEnabled: true });

  assert.deepEqual(metadata.title, {
    default: "La.na Design - charismatic in every yard of cloth.",
    template: "%s — La.na Design",
  });
  assert.equal(metadata.description, "Thời trang nữ thiết kế thanh lịch với áo dài, váy và set đồ");
});

test("A3 no default or public metadata still states Brand #1 or menswear truth", () => {
  const published = JSON.stringify([
    buildRootMetadata({ origin: "https://shop.example.com", indexingEnabled: true }),
    buildStaticPageMetadata({
      origin: "https://shop.example.com",
      indexingEnabled: false,
      pathname: "/",
      searchParams: {},
      title: { absolute: BRAND.identity.homeTitle },
      description: BRAND.identity.homeMetaDescription,
    }),
    BRAND.identity,
    BRAND.contact,
    BRAND.merchant,
    SITE_NAME,
    SOCIAL_FALLBACK_ALT,
  ]);

  for (const stale of [
    "LA Clothing",
    "LA CLOTHING",
    "laclothing",
    "LAclothing",
    "Menswear",
    "menswear",
    "thời trang nam",
  ]) {
    assert.equal(published.includes(stale), false, `${stale} still reaches public metadata`);
  }
});
