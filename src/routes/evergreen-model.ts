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

/**
 * About's facts: the brand positioning, and the registered legal identity.
 *
 * The two addresses are separate fields with separate names on purpose. `registeredAddress` is
 * where the company is registered; `businessAddress` is where a customer sends a return. Both are
 * correct strings, and putting either under the other's heading is the mistake this shape exists to
 * make hard -- a page reads one name or the other, so it cannot pick the wrong fact silently.
 *
 * No legal representative. The owner withheld it from public display, and A2 left no field for it.
 */
export type AboutViewModel = Readonly<{
  positioning: string;
  legalEntityName: string;
  taxCode: string;
  taxIdIssueDate: string;
  /** The registered office. Never the return address. */
  registeredAddress: string;
  /** Corporate/legal correspondence. Never the support inbox. */
  legalEmail: string;
  /** The business and return address, the same one Contact and the footer show. */
  businessAddress: string;
}>;

export function buildAboutViewModel(): AboutViewModel {
  return Object.freeze({
    positioning: PUBLIC_BRAND_POSITIONING,
    legalEntityName: PUBLIC_LEGAL_FACTS.legalEntityName,
    taxCode: PUBLIC_LEGAL_FACTS.taxCode,
    taxIdIssueDate: PUBLIC_LEGAL_FACTS.taxIdIssueDate,
    registeredAddress: PUBLIC_LEGAL_FACTS.registeredAddress,
    legalEmail: PUBLIC_LEGAL_FACTS.legalEmail,
    businessAddress: describePublicAddress(),
  });
}

export type ContactViewModel = Readonly<{
  telephone: string;
  /** E.164, for the `tel:` href. Never shown. */
  telephoneInternational: string;
  /** The customer support inbox. The corporate mailbox is About's, and is a different address. */
  email: string;
  /** The business and return address. The registered office is About's, and is a different place. */
  businessAddress: string;
  supportHours: string;
  /** §15's complaint response target, from the policy authority rather than phrased here. */
  complaintResponse: string;
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
    businessAddress: describePublicAddress(),
    supportHours: describePublicSupportHours(),
    complaintResponse: FULFILLMENT.support.complaintResponseNote,
    fanpageUrl: PUBLIC_CONTACT_FACTS.fanpageUrl,
    fanpageLabel: describeFanpage(PUBLIC_CONTACT_FACTS.fanpageUrl),
  });
}

/* --------------------------------------------------------------------------- shipping */

export type ShippingViewModel = Readonly<{
  coverage: string;
  carriersText: string;
  /** Which carrier handles an order is the shop's choice; §12 says so and the page must too. */
  carrierSelectionNote: string;
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
  /** §14 — stated in the approved words, so the page cannot soften or omit it. */
  bankTransferUnavailable: string;
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
    carrierSelectionNote: delivery.carrierSelectionNote,
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
    bankTransferUnavailable: brandFacts.bankTransferUnavailable,
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
  /**
   * The approved tolerance, or `null` when none applies.
   *
   * One nullable field rather than a note and a caption that could disagree: the sentence and the
   * `±N cm` the per-chart caption repeats are the same fact, and a guide with no tolerance has
   * neither. The page renders the whole statement or omits it.
   */
  tolerance: Readonly<{ note: string; text: string }> | null;
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
  const toleranceText = describePublicSizeTolerance();

  return Object.freeze({
    unit: PUBLIC_SIZE_GUIDE.unit,
    tolerance:
      PUBLIC_SIZE_GUIDE.tolerance === null || toleranceText === null
        ? null
        : Object.freeze({ note: PUBLIC_SIZE_GUIDE.tolerance.note, text: toleranceText }),
    circumferenceSemanticsNote: PUBLIC_SIZE_GUIDE.circumferenceSemanticsNote,
    guidanceNote: PUBLIC_SIZE_GUIDE.guidanceNote,
    charts: PUBLIC_SIZE_GUIDE.charts,
  });
}

/* --------------------------------------------------------------------------- policy hub */

/**
 * The policy topics this storefront publishes, each with a stable anchor.
 *
 * One hub, not a page per clause. Shipping, returns and contact already have pages that render the
 * policy in full, so the hub links to them rather than restating a word: a clause with two homes is
 * a clause that disagrees with itself in one of them after the next edit. The three topics with no
 * page of their own -- payment, online support and complaint handling -- are stated here, and still
 * from the same config constants, never as prose chosen for this page.
 *
 * The anchors are the contract. A footer link to `/policies#khieu-nai` has to keep landing, so the
 * ids are part of the published surface and a test pins them.
 *
 * **What is deliberately absent.** The footer contract in master spec §33 also requires general
 * terms, a pricing policy, a privacy policy, supply conditions and platform rights/obligations.
 * No approved source states any of them — not the master spec, not the normalized PART D policy
 * authority, not the owner-facts intake. Legal prose is the one thing a coding agent must never
 * author, so those five stay unbuilt rather than filled in, and they remain blocked on owner
 * content. A heading with invented text under it would be worse than an absent page, and a heading
 * with nothing under it is a placeholder.
 */
export const POLICY_HUB_TOPICS = [
  {
    id: "van-chuyen",
    title: "Chính sách vận chuyển",
    href: "/shipping",
    linkLabel: "Xem chính sách vận chuyển",
  },
  {
    id: "thanh-toan",
    title: "Chính sách thanh toán",
    href: "/shipping#thanh-toan",
    linkLabel: "Xem chi tiết thanh toán",
  },
  {
    id: "doi-tra-hoan-tien",
    title: "Chính sách đổi trả và hoàn tiền",
    href: "/returns",
    linkLabel: "Xem chính sách đổi trả và hoàn tiền",
  },
  {
    id: "lien-he",
    title: "Thông tin liên hệ",
    href: "/contact",
    linkLabel: "Xem thông tin liên hệ",
  },
  {
    id: "ho-tro-truc-tuyen",
    title: "Các hình thức hỗ trợ trực tuyến",
    href: "/contact",
    linkLabel: "Xem các kênh hỗ trợ",
  },
  {
    id: "khieu-nai",
    title: "Chính sách tiếp nhận và giải quyết phản ánh, khiếu nại",
    href: "/contact",
    linkLabel: "Liên hệ bộ phận hỗ trợ",
  },
] as const;

export type PolicyTopicId = (typeof POLICY_HUB_TOPICS)[number]["id"];

export type PolicyTopicViewModel = Readonly<{
  id: PolicyTopicId;
  title: string;
  /** Where the full policy lives. A route path, optionally with a `#fragment`. */
  href: string;
  linkLabel: string;
  /** One approved constant, never a sentence written for this page. */
  detail: string;
  /** A second approved constant where the topic needs one, otherwise `null`. */
  note: string | null;
}>;

export type PolicyHubViewModel = Readonly<{ topics: readonly PolicyTopicViewModel[] }>;

/** Which approved constant each topic shows. Every value is a member of the fact authority. */
function describePolicyTopic(id: PolicyTopicId): Readonly<{ detail: string; note: string | null }> {
  switch (id) {
    case "van-chuyen":
      return { detail: FULFILLMENT.delivery.coverage, note: null };
    case "thanh-toan":
      return {
        detail: FULFILLMENT.payment.codNote,
        note: FULFILLMENT.payment.bankTransferUnavailableNote,
      };
    case "doi-tra-hoan-tien":
      return { detail: FULFILLMENT.returns.refundChannelNote, note: null };
    case "lien-he":
      return { detail: PUBLIC_CONTACT_FACTS.telephone, note: PUBLIC_CONTACT_FACTS.email };
    case "ho-tro-truc-tuyen":
      return { detail: PUBLIC_CONTACT_FACTS.fanpageUrl, note: PUBLIC_CONTACT_FACTS.email };
    case "khieu-nai":
      return { detail: FULFILLMENT.support.complaintResponseNote, note: null };
  }
}

export function buildPolicyHubViewModel(): PolicyHubViewModel {
  return Object.freeze({
    topics: POLICY_HUB_TOPICS.map((topic) =>
      Object.freeze({ ...topic, ...describePolicyTopic(topic.id) }),
    ),
  });
}
