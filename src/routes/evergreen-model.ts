import { FULFILLMENT } from "../brand/index.ts";
import type { SizeChart } from "../brand/schema.ts";
import {
  describeGuestShippingPromotion,
  type GuestShippingPolicy,
} from "../commerce/guest-shipping-policy.ts";
import {
  buildPublicBrandFacts,
  describePublicAddress,
  describePublicDeliveryEstimate,
  describePublicExchangeFee,
  describePublicRefundWindow,
  describePublicReturnWindow,
  describePublicSizeTolerance,
  describePublicSupportHours,
  PUBLIC_BRAND_POSITIONING,
  PUBLIC_CONTACT_FACTS,
  PUBLIC_DELIVERY_FACTS,
  PUBLIC_LEGAL_FACTS,
  PUBLIC_RETURNS_POLICY,
  PUBLIC_SIZE_GUIDE,
} from "../content/public-brand-facts.ts";

/**
 * What the evergreen pages show, read from the fact authority rather than written into markup.
 *
 * These pages have no request-time data: everything on them is an owner-approved fact. The model
 * exists so the markup can be redrawn per brand without carrying the facts with it, and so the one
 * place a fact can change stays the place the owner's decision is transcribed. Nothing here
 * authors copy — every field is a constant or one of the `describe*` helpers.
 */

export type AboutViewModel = Readonly<{
  positioning: string;
  legalEntityName: string;
  taxCode: string;
  address: string;
}>;

export function buildAboutViewModel(): AboutViewModel {
  return Object.freeze({
    positioning: PUBLIC_BRAND_POSITIONING,
    legalEntityName: PUBLIC_LEGAL_FACTS.legalEntityName,
    taxCode: PUBLIC_LEGAL_FACTS.taxCode,
    address: describePublicAddress(),
  });
}

export type ContactViewModel = Readonly<{
  telephone: string;
  /** E.164, for the `tel:` href. Never shown. */
  telephoneInternational: string;
  email: string;
  address: string;
  supportHours: string;
  fanpageUrl: string;
  /** The fanpage as a reader sees it. */
  fanpageLabel: string;
}>;

/**
 * The fanpage link's visible text, derived from the URL the config holds.
 *
 * `www.` is dropped because it is not how anyone writes a page's name. Deriving rather than
 * transcribing matters here: the label was previously written into the markup, so a brand that
 * changed `fanpageUrl` would have shipped a link whose text named someone else's page.
 */
function describeFanpage(fanpageUrl: string): string {
  const url = new URL(fanpageUrl);
  return `${url.host.replace(/^www\./, "")}${url.pathname.replace(/\/$/, "")}`;
}

export function buildContactViewModel(): ContactViewModel {
  return Object.freeze({
    telephone: PUBLIC_CONTACT_FACTS.telephone,
    telephoneInternational: PUBLIC_CONTACT_FACTS.telephoneInternational,
    email: PUBLIC_CONTACT_FACTS.email,
    address: describePublicAddress(),
    supportHours: describePublicSupportHours(),
    fanpageUrl: PUBLIC_CONTACT_FACTS.fanpageUrl,
    fanpageLabel: describeFanpage(PUBLIC_CONTACT_FACTS.fanpageUrl),
  });
}

/* --------------------------------------------------------------------------- shipping */

export type ShippingViewModel = Readonly<{
  coverage: string;
  carriersText: string;
  /** Owner-approved Hanoi scope labels, so the page never publishes the ambiguous historical ones. */
  innerCityLabel: string;
  innerCityEstimate: string;
  otherProvinceLabel: string;
  otherProvinceEstimate: string;
  estimateCaveat: string;
  shippingPromotionTitle: string;
  shippingPromotionDetail: string;
  carrierTrackingNote: string;
  orderTrackingTitle: string;
  orderTrackingDetail: string;
  phoneConfirmationWording: string;
  paymentMethod: string;
  checkoutAccount: string;
  serverVerification: string;
  refundChannelNote: string;
}>;

/**
 * The Shipping page's facts.
 *
 * The policy is passed in rather than read here: `readGuestShippingPolicy` is a server read and
 * belongs to the loader. Everything derived from it — the promotion wording, the brand facts — is
 * pure, so it is decided here where it can be tested.
 */
export function buildShippingViewModel(
  input: Readonly<{ policy: GuestShippingPolicy }>,
): ShippingViewModel {
  const brandFacts = buildPublicBrandFacts(input.policy);
  const promotion = describeGuestShippingPromotion(input.policy);
  const delivery = PUBLIC_DELIVERY_FACTS;

  return Object.freeze({
    coverage: delivery.coverage,
    carriersText: delivery.carriers.join(" · "),
    innerCityLabel: FULFILLMENT.deliveryScopeLabels.innerCity,
    innerCityEstimate: describePublicDeliveryEstimate(delivery.estimateDays.innerCity),
    otherProvinceLabel: FULFILLMENT.deliveryScopeLabels.otherProvince,
    otherProvinceEstimate: describePublicDeliveryEstimate(delivery.estimateDays.otherProvince),
    estimateCaveat: delivery.estimateCaveat,
    shippingPromotionTitle: promotion.title,
    shippingPromotionDetail: promotion.detail,
    carrierTrackingNote: delivery.carrierTrackingNote,
    orderTrackingTitle: brandFacts.orderTracking.title,
    orderTrackingDetail: brandFacts.orderTracking.detail,
    phoneConfirmationWording: delivery.phoneConfirmationWording,
    paymentMethod: brandFacts.paymentMethod,
    checkoutAccount: brandFacts.checkoutAccount,
    serverVerification: brandFacts.serverVerification,
    refundChannelNote: PUBLIC_RETURNS_POLICY.refundChannelNote,
  });
}

/* ---------------------------------------------------------------------------- returns */

export type ReturnsViewModel = Readonly<{
  returnWindow: string;
  productConditions: readonly string[];
  supportedCases: readonly string[];
  nonDefectiveRefundNote: string;
  /** Empty when the owner approved no category exclusions; the note is shown instead. */
  nonReturnableCategories: readonly string[];
  nonReturnableCategoriesNote: string;
  returnInStore: string;
  returnByMail: string;
  returnByMailResponsibility: string;
  exchangeFee: string;
  customerInitiatedShippingNote: string;
  shopFaultShippingNote: string;
  restockingFeeNote: string;
  refundWindow: string;
  refundChannelNote: string;
}>;

/**
 * The Returns page's facts.
 *
 * Every normative statement is a reviewed content fact. Page prose labels sections and nothing
 * more: policy is the one kind of content a coding agent must never author.
 */
export function buildReturnsViewModel(): ReturnsViewModel {
  const { returnMethods, restockingFeeNote, nonDefectiveRefundNote } = FULFILLMENT.returnLogistics;

  return Object.freeze({
    returnWindow: describePublicReturnWindow(),
    productConditions: PUBLIC_RETURNS_POLICY.productConditions,
    supportedCases: PUBLIC_RETURNS_POLICY.supportedCases,
    nonDefectiveRefundNote,
    nonReturnableCategories: PUBLIC_RETURNS_POLICY.nonReturnableCategories,
    nonReturnableCategoriesNote: PUBLIC_RETURNS_POLICY.nonReturnableCategoriesNote,
    returnInStore: returnMethods.inStore,
    returnByMail: returnMethods.byMail,
    returnByMailResponsibility: returnMethods.byMailResponsibility,
    exchangeFee: describePublicExchangeFee(),
    customerInitiatedShippingNote: PUBLIC_RETURNS_POLICY.customerInitiatedShippingNote,
    shopFaultShippingNote: PUBLIC_RETURNS_POLICY.shopFaultShippingNote,
    restockingFeeNote,
    refundWindow: describePublicRefundWindow(),
    refundChannelNote: PUBLIC_RETURNS_POLICY.refundChannelNote,
  });
}

/* ------------------------------------------------------------------------- size guide */

export type SizeGuideViewModel = Readonly<{
  unit: string;
  toleranceNote: string;
  /** The tolerance as the per-chart caption states it, so the two cannot word it differently. */
  toleranceText: string;
  circumferenceSemanticsNote: string;
  guidanceNote: string;
  /** Every declared chart, each with its own size scale. Charts do not have to agree. */
  charts: readonly SizeChart[];
}>;

/**
 * The Size Guide's facts.
 *
 * The charts pass through whole rather than being reshaped: a brand adding a third table gets a
 * third table and nothing else changes. No size calculator, recommendation or fit vocabulary is
 * derived here — B3 approved the tables, and anything beyond them would be a fit claim this
 * repository invented.
 */
export function buildSizeGuideViewModel(): SizeGuideViewModel {
  return Object.freeze({
    unit: PUBLIC_SIZE_GUIDE.unit,
    toleranceNote: PUBLIC_SIZE_GUIDE.toleranceNote,
    toleranceText: describePublicSizeTolerance(),
    circumferenceSemanticsNote: PUBLIC_SIZE_GUIDE.circumferenceSemanticsNote,
    guidanceNote: PUBLIC_SIZE_GUIDE.guidanceNote,
    charts: PUBLIC_SIZE_GUIDE.charts,
  });
}
