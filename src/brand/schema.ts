import {
  MERCHANT_AGE_GROUPS,
  MERCHANT_GENDERS,
  type MerchantAgeGroup,
  type MerchantGender,
} from "../commerce/merchant-apparel-facts.ts";

/**
 * A constant, not a parameter. The whole template serves Vietnam only: the headless builders format
 * money with a hard-coded `Intl.NumberFormat("vi-VN", { currency: "VND" })`, and the language tests
 * lock the buying surface to Vietnamese. Declaring a configurable locale would be a promise the
 * code does not keep — a brand setting `currency: "USD"` would compile cleanly and then display the
 * wrong money.
 *
 * Revisit when a real brand needs another market or currency. That is a whole piece of work:
 * threading `market` into the headless builders, removing the hard-coded formatting and relaxing
 * the language tests — not widening this type.
 */
export const MARKET_VN = Object.freeze({
  language: "vi",
  country: "VN",
  currency: "VND",
} as const);

export type Market = typeof MARKET_VN;

export type SupportHours = Readonly<{
  days: readonly string[];
  opens: string;
  closes: string;
  utcOffset: string;
  utcOffsetLabel: string;
}>;

export type BrandIdentity = Readonly<{
  name: string;
  displayNameUpper: string;
  /** The site's default page title and the brand line a share card carries. */
  headline: string;
  /** One-line description used as the default meta description and the footer brand summary. */
  tagline: string;
  legalName: string;
  taxId: string;
  /** Exactly one owner-approved sentence. Freehand brand prose is how invented history ships. */
  positioning: string;
  /** Must match the social card route directory under src/app, minus its `.png` suffix. */
  socialCardSlug: string;
  socialCardAlt: string;
  /**
   * Identity strings too short for the brand-leak scanner's four-character floor, declared so they
   * are still protected. Empty for a brand whose name is long enough.
   */
  additionalNeedles: readonly string[];
}>;

export type BrandContact = Readonly<{
  telephone: string;
  telephoneInternational: string;
  email: string;
  fanpageUrl: string;
  streetAddress: string;
  addressLocality: string;
  supportHours: SupportHours;
}>;

export type BrandMerchant = Readonly<{
  feedBrand: string;
  defaultGender: MerchantGender;
  defaultAgeGroup: MerchantAgeGroup;
}>;

export type BrandConfig = Readonly<{
  identity: BrandIdentity;
  contact: BrandContact;
  merchant: BrandMerchant;
  market: Market;
}>;

export type SizeChart = Readonly<{
  id: string;
  title: string;
  /** Each chart carries its own size scale; charts do not have to agree. */
  sizes: readonly string[];
  rows: readonly Readonly<{
    parameter: string;
    values: Readonly<Record<string, string>>;
  }>[];
}>;

export type SizeGuideConfig = Readonly<{
  unit: string;
  toleranceCm: number;
  toleranceNote: string;
  circumferenceSemanticsNote: string;
  guidanceNote: string;
  charts: readonly SizeChart[];
}>;

export type NavigationLink = Readonly<{ href: string; label: string }>;

export type NavigationConfig = Readonly<{
  brandHomeLabel: string;
  primary: readonly NavigationLink[];
  mobileUtility: readonly NavigationLink[];
  utility: readonly NavigationLink[];
  footer: readonly NavigationLink[];
}>;

export { MERCHANT_AGE_GROUPS, MERCHANT_GENDERS };
export type { MerchantAgeGroup, MerchantGender };
