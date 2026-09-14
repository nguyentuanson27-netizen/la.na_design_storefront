import { normalizeVietnamesePhone } from "../integrations/meta/conversions-api.ts";
import { BRAND as RAW_BRAND } from "./brand.config.ts";
import { NAVIGATION as RAW_NAVIGATION } from "./navigation.config.ts";
import {
  MARKET_VN,
  MERCHANT_AGE_GROUPS,
  MERCHANT_GENDERS,
  type BrandConfig,
  type NavigationConfig,
  type SizeGuideConfig,
} from "./schema.ts";
import { SIZE_GUIDE as RAW_SIZE_GUIDE } from "./size-guide.config.ts";

export * from "./schema.ts";

/**
 * Brand facts are read all over the storefront and written nowhere. Freezing the whole tree after
 * validation keeps the loader's guarantees true for the process's lifetime instead of only at the
 * moment it ran.
 */
function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return value;
}

function fail(message: string): never {
  throw new Error(`Invalid brand configuration: ${message}`);
}

function requireText(value: string, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    // A blank required fact is how a footer ends up rendering an empty line where a phone number
    // belongs, so it stops the process rather than reaching a page.
    fail(`${label} must not be empty`);
  }
  return value;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** One sentence: no internal sentence break, and a single terminator at most, at the end. */
const SENTENCE_BREAK_PATTERN = /[.!?]\s+\S/;

function validateIdentity(brand: BrandConfig): void {
  const { identity } = brand;
  for (const [label, value] of Object.entries({
    name: identity.name,
    displayNameUpper: identity.displayNameUpper,
    legalName: identity.legalName,
    taxId: identity.taxId,
    positioning: identity.positioning,
    socialCardSlug: identity.socialCardSlug,
    socialCardAlt: identity.socialCardAlt,
  })) {
    requireText(value, `identity.${label}`);
  }

  if (SENTENCE_BREAK_PATTERN.test(identity.positioning.trim())) {
    fail("identity.positioning must be exactly one sentence");
  }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(identity.socialCardSlug)) {
    fail("identity.socialCardSlug must be a lowercase route-directory slug");
  }
  for (const needle of identity.additionalNeedles) {
    requireText(needle, "identity.additionalNeedles entry");
  }
}

function validateContact(brand: BrandConfig): void {
  const { contact } = brand;
  for (const [label, value] of Object.entries({
    telephone: contact.telephone,
    telephoneInternational: contact.telephoneInternational,
    email: contact.email,
    fanpageUrl: contact.fanpageUrl,
    streetAddress: contact.streetAddress,
    addressLocality: contact.addressLocality,
  })) {
    requireText(value, `contact.${label}`);
  }

  // The two spellings are one approved number. The repository already owns the normalization, so
  // the derivation is pinned against it rather than restated here.
  const normalized = normalizeVietnamesePhone(contact.telephone);
  if (normalized === null || `+${normalized}` !== contact.telephoneInternational) {
    fail(
      "contact.telephoneInternational must be contact.telephone in its international spelling",
    );
  }

  if (!EMAIL_PATTERN.test(contact.email)) fail("contact.email must be a valid email address");

  let fanpage: URL;
  try {
    fanpage = new URL(contact.fanpageUrl);
  } catch {
    fail("contact.fanpageUrl must be an absolute URL");
  }
  if (fanpage.protocol !== "https:") fail("contact.fanpageUrl must use HTTPS");

  const { days, opens, closes, utcOffset, utcOffsetLabel } = contact.supportHours;
  if (days.length === 0) fail("contact.supportHours.days must list at least one day");
  for (const [label, value] of Object.entries({ opens, closes, utcOffset, utcOffsetLabel })) {
    requireText(value, `contact.supportHours.${label}`);
  }
  for (const [label, value] of Object.entries({ opens, closes })) {
    if (!/^\d{2}:\d{2}$/.test(value)) fail(`contact.supportHours.${label} must be HH:MM`);
  }
  if (!/^[+-]\d{2}:\d{2}$/.test(utcOffset)) {
    fail("contact.supportHours.utcOffset must be an ISO 8601 offset");
  }
}

function validateMerchant(brand: BrandConfig): void {
  requireText(brand.merchant.feedBrand, "merchant.feedBrand");
  if (!MERCHANT_GENDERS.includes(brand.merchant.defaultGender)) {
    fail("merchant.defaultGender must be a Google Merchant controlled value");
  }
  if (!MERCHANT_AGE_GROUPS.includes(brand.merchant.defaultAgeGroup)) {
    fail("merchant.defaultAgeGroup must be a Google Merchant controlled value");
  }
}

function validateMarket(brand: BrandConfig): void {
  // The type already makes anything else uncompilable; this catches a cast or an untyped import.
  if (
    brand.market.language !== MARKET_VN.language ||
    brand.market.country !== MARKET_VN.country ||
    brand.market.currency !== MARKET_VN.currency
  ) {
    fail("market must be MARKET_VN; this template serves Vietnam and VND only");
  }
}

function validateSizeGuide(sizeGuide: SizeGuideConfig): void {
  requireText(sizeGuide.unit, "sizeGuide.unit");
  for (const [label, value] of Object.entries({
    toleranceNote: sizeGuide.toleranceNote,
    circumferenceSemanticsNote: sizeGuide.circumferenceSemanticsNote,
    guidanceNote: sizeGuide.guidanceNote,
  })) {
    requireText(value, `sizeGuide.${label}`);
  }
  if (!Number.isFinite(sizeGuide.toleranceCm) || sizeGuide.toleranceCm < 0) {
    fail("sizeGuide.toleranceCm must be a non-negative number");
  }
  if (sizeGuide.charts.length < 1) fail("sizeGuide.charts must contain at least one chart");

  const seenIds = new Set<string>();
  for (const chart of sizeGuide.charts) {
    requireText(chart.id, "sizeGuide chart id");
    requireText(chart.title, `sizeGuide chart ${chart.id} title`);
    if (seenIds.has(chart.id)) fail(`sizeGuide chart id "${chart.id}" is duplicated`);
    seenIds.add(chart.id);

    if (chart.sizes.length === 0) fail(`sizeGuide chart "${chart.id}" must declare its sizes`);
    if (new Set(chart.sizes).size !== chart.sizes.length) {
      fail(`sizeGuide chart "${chart.id}" repeats a size`);
    }
    if (chart.rows.length === 0) fail(`sizeGuide chart "${chart.id}" must have at least one row`);

    const expected = [...chart.sizes].sort();
    for (const row of chart.rows) {
      requireText(row.parameter, `sizeGuide chart "${chart.id}" row parameter`);
      // Exactly the chart's sizes, no more and no fewer. Transcribing a new table by hand is
      // precisely where a missing or stray size key appears, and it renders as a blank cell.
      const actual = Object.keys(row.values).sort();
      if (actual.length !== expected.length || actual.some((key, i) => key !== expected[i])) {
        fail(
          `sizeGuide chart "${chart.id}" row "${row.parameter}" must carry exactly the sizes ${chart.sizes.join(", ")}`,
        );
      }
      for (const size of chart.sizes) {
        requireText(row.values[size] as string, `sizeGuide chart "${chart.id}" row "${row.parameter}" value for ${size}`);
      }
    }
  }
}

function validateNavigation(navigation: NavigationConfig): void {
  requireText(navigation.brandHomeLabel, "navigation.brandHomeLabel");
  for (const [group, links] of Object.entries({
    primary: navigation.primary,
    mobileUtility: navigation.mobileUtility,
    utility: navigation.utility,
    footer: navigation.footer,
  })) {
    if (links.length === 0) fail(`navigation.${group} must have at least one link`);
    const seen = new Set<string>();
    for (const link of links) {
      requireText(link.label, `navigation.${group} link label`);
      if (!link.href.startsWith("/")) {
        fail(`navigation.${group} link "${link.label}" must be a site-relative path`);
      }
      if (seen.has(link.href)) fail(`navigation.${group} repeats "${link.href}"`);
      seen.add(link.href);
    }
  }
}

/**
 * Validates the whole brand contract, fail-closed.
 *
 * Called once below, at module load, rather than per request.
 *
 * One check from the contract deliberately lives in a test instead: that `identity.socialCardSlug`
 * matches the real route directory under `src/app`. Reading the filesystem here would pull
 * `node:fs` into every bundle that imports navigation or brand facts. The correspondence is pinned
 * by `tests/domain/brand-leak.test.ts`, so a mismatch still fails the build.
 */
export function loadBrandConfig(
  brand: BrandConfig = RAW_BRAND,
  sizeGuide: SizeGuideConfig = RAW_SIZE_GUIDE,
  navigation: NavigationConfig = RAW_NAVIGATION,
): Readonly<{ brand: BrandConfig; sizeGuide: SizeGuideConfig; navigation: NavigationConfig }> {
  validateIdentity(brand);
  validateContact(brand);
  validateMerchant(brand);
  validateMarket(brand);
  validateSizeGuide(sizeGuide);
  validateNavigation(navigation);
  return Object.freeze({
    brand: deepFreeze(brand),
    sizeGuide: deepFreeze(sizeGuide),
    navigation: deepFreeze(navigation),
  });
}

const loaded = loadBrandConfig();

export const BRAND = loaded.brand;
export const SIZE_GUIDE = loaded.sizeGuide;
export const NAVIGATION = loaded.navigation;
