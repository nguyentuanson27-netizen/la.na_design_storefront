// Types only. A value import here would make src/brand depend on the commerce layer at runtime,
// and the commerce layer reads the brand's merchant defaults -- the cycle would decide which of the
// two initializes first.
import type {
  MerchantAgeGroup,
  MerchantGender,
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

/**
 * Part of the same Vietnam lock: the calling code the approved national phone number is published
 * under internationally. A test pins the derivation against the repository's reviewed
 * `normalizeVietnamesePhone`, so this constant cannot drift from how checkout normalizes a number.
 */
export const VIETNAM_CALLING_CODE = "84";

/** Vietnam market UTC offset, centralized so machine-readable commerce facts do not hardcode it. */
export const VIETNAM_UTC_OFFSET = "+07:00";

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
  /** The short brand line the site footer shows under the wordmark. */
  strapline: string;
  legalName: string;
  taxId: string;
  /** Exactly one owner-approved sentence. Freehand brand prose is how invented history ships. */
  positioning: string;
  /** Must match the social card route directory under src/app, minus its `.png` suffix. */
  socialCardSlug: string;
  socialCardAlt: string;
  /**
   * The homepage's own approved `<title>`, published absolutely.
   *
   * Separate from `headline` because they answer different questions: `headline` is the default
   * title a route inherits when it declares none, while this is the one the owner approved for the
   * homepage specifically. It already carries the brand name, so the site title template must not
   * append it a second time.
   */
  homeTitle: string;
  /** The homepage's own approved meta description, separate from the inherited `tagline`. */
  homeMetaDescription: string;
  /**
   * The homepage brand-story paragraph the owner approved word for word (master spec §5, §23).
   *
   * A third distinct string, and deliberately not folded into `tagline` or `homeMetaDescription`:
   * the tagline is the short line a route inherits, the meta description is written for a search
   * result, and this is body copy a shopper reads. Rewording any of them to serve another surface
   * would be inventing brand voice the owner did not approve.
   */
  homeBrandStory: string;
  /**
   * The brand's approved search/SEO spelling variant.
   *
   * Usable in structured data, search matching and natural SEO copy. It is **not** a display name
   * and the loader refuses it if it is set to one: a brand with two public spellings is a brand a
   * reader cannot recognise. It is also not a licence to build a doorway page per spelling.
   */
  searchAlias: string;
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
  /**
   * The brand's other public profiles, shown as icons beside the fanpage in the footer. Optional:
   * a profile nobody has confirmed is left out rather than guessed, and its icon simply does not
   * render.
   */
  instagramUrl?: string;
  tiktokUrl?: string;
  streetAddress: string;
  addressLocality: string;
  supportHours: SupportHours;
}>;

/**
 * The registered legal entity's own contact facts.
 *
 * Separate from {@link BrandContact} because they are separate facts about separate places: the
 * registered address is where the company is registered, the business address is where customers
 * send returns, and the corporate mailbox is not the support inbox. One shared address/email pair
 * could only hold one of each, so publishing the registered identity would have meant overwriting
 * the customer-facing contact or restating it as page prose.
 *
 * `legalName` and `taxId` stay on {@link BrandIdentity}: they are already published there and
 * moving them would churn every consumer for no gain. `src/content/public-brand-facts.ts` joins
 * both halves into the one projection the About/legal surface reads.
 *
 * The representative was withheld from public display until the owner released it for the footer's
 * legal block (owner-facts §3b). It is a required string like every other fact here: a blank would
 * publish the label `Đại diện pháp luật:` with nothing after it, which is worse than either state.
 */
export type BrandLegal = Readonly<{
  /** The registered office, as the registration source states it. Never the return address. */
  registeredAddress: string;
  /** Corporate/legal correspondence. Customer service uses `BrandContact.email`. */
  email: string;
  /**
   * The registered legal representative, in the casing the registration source states them in.
   * Published in the footer's legal block; `/about` renders the fact set it already had.
   */
  legalRepresentative: string;
  /**
   * The date the tax ID was issued, in the Vietnamese day/month/year order the source states it in.
   * Kept as the approved string rather than an ISO date: reading `7/10/2025` month-first would move
   * the date by three months, and no consumer needs a machine-readable form yet.
   */
  taxIdIssueDate: string;
}>;

export type BrandMerchant = Readonly<{
  feedBrand: string;
  defaultGender: MerchantGender;
  defaultAgeGroup: MerchantAgeGroup;
}>;

export type BrandConfig = Readonly<{
  identity: BrandIdentity;
  contact: BrandContact;
  legal: BrandLegal;
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

/**
 * A published manufacturing tolerance, when the brand has one.
 *
 * The number and the sentence travel together so a brand cannot end up with a note that states no
 * figure, or a figure no page explains. `null` on {@link SizeGuideConfig.tolerance} is the whole
 * representation of "no fixed tolerance applies": there is no number to render, so there is nothing
 * for a page to round down to `0` and publish as one.
 */
export type SizeTolerance = Readonly<{ cm: number; note: string }>;

export type SizeGuideConfig = Readonly<{
  unit: string;
  /** `null` when no fixed tolerance applies. Never `0`, which would be a tolerance of zero. */
  tolerance: SizeTolerance | null;
  circumferenceSemanticsNote: string;
  guidanceNote: string;
  charts: readonly SizeChart[];
}>;

export type DayRange = Readonly<{ minimum: number; maximum: number }>;

export type FulfillmentConfig = Readonly<{
  returns: Readonly<{
    windowDays: number;
    productConditions: readonly string[];
    supportedCases: readonly string[];
    customerInitiatedExchangeFeeVnd: number;
    customerInitiatedShippingNote: string;
    shopFaultShippingNote: string;
    nonReturnableCategories: readonly string[];
    nonReturnableCategoriesNote: string;
    refundWorkingDays: DayRange;
    refundChannelNote: string;
  }>;
  delivery: Readonly<{
    coverage: string;
    carriers: readonly string[];
    /** Which of the carriers handles an order is the shop's choice, not the shopper's. */
    carrierSelectionNote: string;
    estimateDays: Readonly<{ innerCity: DayRange; otherProvince: DayRange }>;
    estimateCaveat: string;
    carrierTrackingNote: string;
    phoneConfirmationWording: string;
  }>;
  deliveryScopeLabels: Readonly<{ innerCity: string; otherProvince: string }>;
  /**
   * What the website can currently take, and what it cannot.
   *
   * Payment availability is a policy commitment, not presentation: "bank transfer is temporarily
   * unavailable" is a sentence the owner approved word for word, and a page that reworded it would
   * be making a different statement about the same fact. It lives beside delivery and returns
   * because those are the other two halves of what a buyer is promised at checkout.
   *
   * No account detail belongs here. Bank transfer is off, and a stored account number is how a
   * disabled method starts being usable again by accident.
   */
  payment: Readonly<{ codNote: string; bankTransferUnavailableNote: string }>;
  /** Post-sale support commitments that are neither a delivery nor a return term. */
  support: Readonly<{ complaintResponseNote: string }>;
  returnLogistics: Readonly<{
    returnMethods: Readonly<{
      inStore: string;
      byMail: string;
      byMailResponsibility: string;
    }>;
    restockingFeeVnd: number;
    restockingFeeNote: string;
    nonDefectiveRefundNote: string;
  }>;
}>;

export type NavigationLink = Readonly<{ href: string; label: string }>;

export type NavigationConfig = Readonly<{
  brandHomeLabel: string;
  primary: readonly NavigationLink[];
  mobileUtility: readonly NavigationLink[];
  utility: readonly NavigationLink[];
  footer: readonly NavigationLink[];
}>;

export type { MerchantAgeGroup, MerchantGender };
