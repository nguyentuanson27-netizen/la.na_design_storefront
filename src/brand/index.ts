import {
  MERCHANT_AGE_GROUPS,
  MERCHANT_GENDERS,
} from "../commerce/merchant-apparel-facts.ts";
import { BRAND as RAW_BRAND } from "./brand.config.ts";
import { FULFILLMENT as RAW_FULFILLMENT } from "./fulfillment.config.ts";
import { NAVIGATION as RAW_NAVIGATION } from "./navigation.config.ts";
import {
  MARKET_VN,
  VIETNAM_CALLING_CODE,
  type BrandConfig,
  type FulfillmentConfig,
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
/**
 * One leading slash, then a path that cannot start a new authority. Rejects "//host", "/\\host"
 * (which several browsers normalize to "//host"), and anything carrying a scheme.
 */
const SITE_RELATIVE_HREF = /^\/(?![/\\])[^\s]*$/;
/** One sentence: no internal sentence break, and a single terminator at most, at the end. */
const SENTENCE_BREAK_PATTERN = /[.!?]\s+\S/;

function validateIdentity(brand: BrandConfig): void {
  const { identity } = brand;
  for (const [label, value] of Object.entries({
    name: identity.name,
    displayNameUpper: identity.displayNameUpper,
    headline: identity.headline,
    tagline: identity.tagline,
    strapline: identity.strapline,
    legalName: identity.legalName,
    taxId: identity.taxId,
    positioning: identity.positioning,
    socialCardSlug: identity.socialCardSlug,
    socialCardAlt: identity.socialCardAlt,
    homeTitle: identity.homeTitle,
    homeMetaDescription: identity.homeMetaDescription,
    searchAlias: identity.searchAlias,
  })) {
    requireText(value, `identity.${label}`);
  }

  // An alias that equals a display spelling is not an alias -- it is a second public name, which is
  // exactly what the approved decision forbids.
  if (
    identity.searchAlias === identity.name ||
    identity.searchAlias === identity.displayNameUpper
  ) {
    fail("identity.searchAlias must differ from the public display name; it is a search alias only");
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

  // The two spellings are one approved number: the trunk zero is replaced by the market's calling
  // code and no subscriber digit changes. The check is self-contained so src/brand stays free of
  // runtime dependencies on the integration layer; a domain test pins it against the repository's
  // reviewed normalizeVietnamesePhone so the two definitions cannot drift.
  if (!/^0\d{8,10}$/.test(contact.telephone)) {
    fail("contact.telephone must be a Vietnamese national number starting with a trunk zero");
  }
  if (contact.telephoneInternational !== `+${VIETNAM_CALLING_CODE}${contact.telephone.slice(1)}`) {
    fail("contact.telephoneInternational must be contact.telephone in its international spelling");
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

/**
 * The registered legal facts, checked on their own terms rather than the contact block's.
 *
 * The date is validated for shape only. `7/10/2025` is the approved transcription of a Vietnamese
 * registration document, so the check is that it still reads day/month/year with a four-digit year
 * -- enough to catch an ISO string or a two-digit year pasted in later, without pretending this
 * module can tell whether the date itself is right.
 */
function validateLegal(brand: BrandConfig): void {
  const { legal } = brand;
  for (const [label, value] of Object.entries({
    registeredAddress: legal.registeredAddress,
    email: legal.email,
    taxIdIssueDate: legal.taxIdIssueDate,
    legalRepresentative: legal.legalRepresentative,
  })) {
    requireText(value, `legal.${label}`);
  }

  if (!EMAIL_PATTERN.test(legal.email)) fail("legal.email must be a valid email address");
  if (!/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(legal.taxIdIssueDate)) {
    fail("legal.taxIdIssueDate must be a day/month/year date, as the registration source states it");
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
    circumferenceSemanticsNote: sizeGuide.circumferenceSemanticsNote,
    guidanceNote: sizeGuide.guidanceNote,
  })) {
    requireText(value, `sizeGuide.${label}`);
  }
  // `null` is a fact -- no fixed tolerance applies -- and is left alone. A tolerance that is
  // present is still checked as strictly as before, so absence is a decision rather than a gap the
  // loader stopped looking at. Zero is rejected: a brand with no tolerance says so with `null`, and
  // `0` would publish a promise of exact measurements.
  if (sizeGuide.tolerance !== null) {
    requireText(sizeGuide.tolerance.note, "sizeGuide.tolerance.note");
    if (!Number.isFinite(sizeGuide.tolerance.cm) || sizeGuide.tolerance.cm <= 0) {
      fail("sizeGuide.tolerance.cm must be a positive number; use null when none applies");
    }
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

function validateFulfillment(fulfillment: FulfillmentConfig): void {
  const { returns, delivery, deliveryScopeLabels, returnLogistics } = fulfillment;

  for (const [label, value] of Object.entries({
    customerInitiatedShippingNote: returns.customerInitiatedShippingNote,
    shopFaultShippingNote: returns.shopFaultShippingNote,
    nonReturnableCategoriesNote: returns.nonReturnableCategoriesNote,
    refundChannelNote: returns.refundChannelNote,
  })) {
    requireText(value, `fulfillment.returns.${label}`);
  }
  if (!Number.isInteger(returns.windowDays) || returns.windowDays < 1) {
    fail("fulfillment.returns.windowDays must be a positive whole number of days");
  }
  if (returns.productConditions.length === 0) {
    fail("fulfillment.returns.productConditions must list the approved conditions");
  }
  if (returns.supportedCases.length === 0) {
    fail("fulfillment.returns.supportedCases must list the approved cases");
  }
  for (const condition of returns.productConditions) {
    requireText(condition, "fulfillment.returns.productConditions entry");
  }
  for (const supported of returns.supportedCases) {
    requireText(supported, "fulfillment.returns.supportedCases entry");
  }
  if (!Number.isInteger(returns.customerInitiatedExchangeFeeVnd) || returns.customerInitiatedExchangeFeeVnd < 0) {
    fail("fulfillment.returns.customerInitiatedExchangeFeeVnd must be a non-negative whole VND amount");
  }
  assertDayRange(returns.refundWorkingDays, "fulfillment.returns.refundWorkingDays");

  for (const [label, value] of Object.entries({
    coverage: delivery.coverage,
    carrierSelectionNote: delivery.carrierSelectionNote,
    estimateCaveat: delivery.estimateCaveat,
    carrierTrackingNote: delivery.carrierTrackingNote,
    phoneConfirmationWording: delivery.phoneConfirmationWording,
  })) {
    requireText(value, `fulfillment.delivery.${label}`);
  }
  if (delivery.carriers.length === 0) fail("fulfillment.delivery.carriers must name a carrier");
  for (const carrier of delivery.carriers) {
    requireText(carrier, "fulfillment.delivery.carriers entry");
  }
  assertDayRange(delivery.estimateDays.innerCity, "fulfillment.delivery.estimateDays.innerCity");
  assertDayRange(
    delivery.estimateDays.otherProvince,
    "fulfillment.delivery.estimateDays.otherProvince",
  );

  requireText(deliveryScopeLabels.innerCity, "fulfillment.deliveryScopeLabels.innerCity");
  requireText(deliveryScopeLabels.otherProvince, "fulfillment.deliveryScopeLabels.otherProvince");

  for (const [label, value] of Object.entries(returnLogistics.returnMethods)) {
    requireText(value, `fulfillment.returnLogistics.returnMethods.${label}`);
  }
  requireText(returnLogistics.restockingFeeNote, "fulfillment.returnLogistics.restockingFeeNote");
  requireText(
    returnLogistics.nonDefectiveRefundNote,
    "fulfillment.returnLogistics.nonDefectiveRefundNote",
  );
  if (!Number.isInteger(returnLogistics.restockingFeeVnd) || returnLogistics.restockingFeeVnd < 0) {
    fail("fulfillment.returnLogistics.restockingFeeVnd must be a non-negative whole VND amount");
  }

  for (const [label, value] of Object.entries(fulfillment.payment)) {
    requireText(value, `fulfillment.payment.${label}`);
  }
  requireText(fulfillment.support.complaintResponseNote, "fulfillment.support.complaintResponseNote");
}

/** A published window is only meaningful if it is whole days and does not run backwards. */
function assertDayRange(range: { minimum: number; maximum: number }, label: string): void {
  if (!Number.isInteger(range.minimum) || range.minimum < 1) {
    fail(`${label}.minimum must be a positive whole number of days`);
  }
  if (!Number.isInteger(range.maximum) || range.maximum < range.minimum) {
    fail(`${label}.maximum must be a whole number of days not smaller than the minimum`);
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
      // A single leading slash is not enough: "//evil.example/path" is protocol-relative, which the
      // browser resolves as an absolute URL on another origin. A menu entry is always same-origin,
      // so anything that can leave the site is rejected here rather than trusted to the renderer.
      if (!SITE_RELATIVE_HREF.test(link.href)) {
        fail(
          `navigation.${group} link "${link.label}" must be a site-relative path starting with a single "/"`,
        );
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
  fulfillment: FulfillmentConfig = RAW_FULFILLMENT,
): Readonly<{
  brand: BrandConfig;
  sizeGuide: SizeGuideConfig;
  navigation: NavigationConfig;
  fulfillment: FulfillmentConfig;
}> {
  validateIdentity(brand);
  validateContact(brand);
  validateLegal(brand);
  validateMerchant(brand);
  validateMarket(brand);
  validateSizeGuide(sizeGuide);
  validateNavigation(navigation);
  validateFulfillment(fulfillment);
  return Object.freeze({
    brand: deepFreeze(brand),
    sizeGuide: deepFreeze(sizeGuide),
    navigation: deepFreeze(navigation),
    fulfillment: deepFreeze(fulfillment),
  });
}

const loaded = loadBrandConfig();

export const BRAND = loaded.brand;
export const SIZE_GUIDE = loaded.sizeGuide;
export const NAVIGATION = loaded.navigation;
export const FULFILLMENT = loaded.fulfillment;

export { HOME_SERVICE_FACTS } from "./fulfillment.config.ts";

export {
  APPROVED_SIZE_GUIDE_IDS,
  type ApprovedSizeGuideId,
  isApprovedSizeGuideId,
  APPROVED_SIZE_GUIDES,
} from "./size-guide.config.ts";

