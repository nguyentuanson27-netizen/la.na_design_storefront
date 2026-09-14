import { BRAND, FULFILLMENT, SIZE_GUIDE } from "../brand/index.ts";
import {
  describeGuestShippingPromotion,
  type GuestShippingPolicy,
} from "../commerce/guest-shipping-policy.ts";

export function buildPublicBrandFacts(policy: GuestShippingPolicy) {
  return Object.freeze({
    brandName: BRAND.identity.name,
    brandSummary: BRAND.identity.tagline,
    paymentMethod: "Thanh toán khi nhận hàng (COD).",
    checkoutAccount: "Không cần tài khoản để thanh toán.",
    shipping: describeGuestShippingPromotion(policy),
    orderTracking: Object.freeze({
      title: "Tra cứu đơn hàng",
      detail: "Tra cứu trạng thái đơn COD bằng mã đơn và số điện thoại đã dùng khi đặt hàng.",
    }),
    serverVerification:
      "Giá, tồn kho và phí vận chuyển được máy chủ kiểm tra lại khi bạn đặt hàng.",
  });
}

/**
 * B2 — the contact facts the repository owner approved for publication, transcribed from
 * `docs/specs/la-clothing-owner-approved-facts-and-decisions.md` §2 and nothing else.
 *
 * The facts themselves now live in `BRAND.contact`; this stays as the name existing consumers read
 * them by. The authority moved, the approval discipline did not: no page may state a contact fact
 * that is not in Brand Config. The site footer renders these and the `Organization` entity in the
 * site JSON-LD marks the same values up, both through this binding, so the visible text and the
 * structured data cannot end up publishing two different phone numbers.
 *
 * Support hours are stored as their parts — the seven days, the local open/close times and the
 * approved `UTC+7` offset — because two consumers need two shapes of the same fact: schema.org
 * wants an ISO 8601 time carrying the offset, a reader wants a sentence. Both are derived here by
 * {@link supportHoursSchemaTime} and {@link describePublicSupportHours}, so neither can drift.
 *
 * What is deliberately absent:
 *
 * - **No logo.** B2 approved no brand mark. `SOCIAL_FALLBACK_PATH` is a share card, not a logo, and
 *   publishing it as one would misstate what the asset is.
 * - **No `addressCountry` or `postalCode`.** The owner approved an address *string*, not a
 *   structured postal address, and deriving a country from a city name is an inference.
 * - **No Zalo URL.** The approved fact is one number reachable by phone and Zalo; a profile URL for
 *   it does not exist in any source.
 *
 * `telephone` and `telephoneInternational` are the **same approved number**, written two ways. The
 * owner approved `0923159666`, a Vietnamese national form with the trunk zero; Google's Organization
 * guidance asks `contactPoint.telephone` to carry the country code. The calling code is not inferred
 * from the address — it comes from **O2**, the owner decision that the country/market is Việt Nam
 * (`+84`). No subscriber digit is added or changed: the trunk zero is replaced by the approved
 * country's calling code, and a test pins that against the repository's existing reviewed
 * `normalizeVietnamesePhone`, so the two spellings cannot drift apart or hide a typo.
 * - **No `legalName` or `taxID`.** B6 *does* approve publishing the legal entity and the confirmed
 *   MST — this is not an owner block. They are simply **outside the B2 contact contract** this
 *   constant owns; they belong to the About/legal surface U33 builds.
 */
export const PUBLIC_CONTACT_FACTS = BRAND.contact;

/** The full postal address as the owner wrote it, for surfaces that show one line. */
export function describePublicAddress(): string {
  return `${PUBLIC_CONTACT_FACTS.streetAddress}, ${PUBLIC_CONTACT_FACTS.addressLocality}`;
}

/**
 * A local support time as a schema.org `Time`: ISO 8601 carrying the approved offset, so a consumer
 * reading `08:00` cannot resolve it against its own timezone.
 */
export function supportHoursSchemaTime(localTime: string): string {
  return `${localTime}:00${PUBLIC_CONTACT_FACTS.supportHours.utcOffset}`;
}

/** The same hours as a sentence a reader sees, built from the same parts the markup uses. */
export function describePublicSupportHours(): string {
  const { days, opens, closes, utcOffsetLabel } = PUBLIC_CONTACT_FACTS.supportHours;
  const cadence = days.length === 7 ? "hằng ngày" : days.join(", ");
  return `${opens} - ${closes} ${cadence} (${utcOffsetLabel})`;
}

/**
 * B6/§7 — the brand positioning the owner approved for publication, as one sentence.
 *
 * The owner withheld the founding year, the founder and any brand story or values beyond this
 * sentence. It is a constant rather than page prose for exactly that reason: an About page written
 * freehand is how an invented history reaches the storefront, and a test pins this against §7 word
 * for word.
 */
export const PUBLIC_BRAND_POSITIONING = BRAND.identity.positioning;

/**
 * §1 legal identity, approved for publication on a minimal About page by B6/§7.
 *
 * Only the entity name and the confirmed MST live here. The **address is not duplicated**: it is a
 * §2 contact fact, so `PUBLIC_CONTACT_FACTS` owns it and `/about` renders it through
 * `describePublicAddress()`, the same call the footer and the `Organization` node use.
 *
 * U32b left these out because they are not B2 contact facts and the `Organization` entity it built
 * implements the B2 contract. The About/legal surface is where they belong, and this is where a
 * later `legalName`/`taxID` mapping would read them from.
 */
export const PUBLIC_LEGAL_FACTS = Object.freeze({
  legalEntityName: BRAND.identity.legalName,
  taxCode: BRAND.identity.taxId,
});

const vnd = new Intl.NumberFormat("vi-VN", {
  style: "currency",
  currency: "VND",
  maximumFractionDigits: 0,
});

/**
 * B1/§4 returns policy and B4/§5 delivery facts, now owned by `FULFILLMENT` in Brand Config and
 * bound here under the names existing consumers read them by.
 *
 * The approval discipline is unchanged: policy is the one kind of content a coding agent must never
 * author, so every clause a page shows is still a member of the config rather than page prose. What
 * changed is that the shop's own name is interpolated from `BRAND.identity` instead of written into
 * the sentences, so a fork restates its policy in one place.
 */
export const PUBLIC_RETURNS_POLICY = FULFILLMENT.returns;

export const PUBLIC_DELIVERY_FACTS = FULFILLMENT.delivery;

/** The approved customer-initiated exchange fee, formatted for a reader. */
export function describePublicExchangeFee(): string {
  return `${vnd.format(PUBLIC_RETURNS_POLICY.customerInitiatedExchangeFeeVnd)} / sản phẩm`;
}

/** An approved delivery estimate as a range of days; always an estimate, never an SLA. */
export function describePublicDeliveryEstimate(
  estimate: Readonly<{ minimum: number; maximum: number }>,
): string {
  return `${estimate.minimum}–${estimate.maximum} ngày`;
}

/**
 * The return window with its start point. §4 does not say "15 days"; it says fifteen days **from the
 * day the customer receives the order**, and the start point is the half a buyer argues about. The
 * number stays single-sourced in `windowDays` and the semantics live here rather than in page prose.
 */
export function describePublicReturnWindow(): string {
  return `${PUBLIC_RETURNS_POLICY.windowDays} ngày kể từ ngày khách hàng nhận hàng`;
}

/**
 * The refund window with the event its clock starts from. As with the return window, the range is
 * the easy half: §4 starts counting only once LA Clothing has the product back, has inspected it and
 * has confirmed eligibility, and omitting that would promise a faster refund than the owner approved.
 */
export function describePublicRefundWindow(): string {
  const { minimum, maximum } = PUBLIC_RETURNS_POLICY.refundWorkingDays;
  return `${minimum}–${maximum} ngày làm việc kể từ khi ${BRAND.identity.name} nhận lại sản phẩm, kiểm tra và xác nhận đủ điều kiện hoàn tiền`;
}

/**
 * B3/§6 — the size guide facts the owner approved, now held by `SIZE_GUIDE` in Brand Config and
 * bound here under the name existing consumers read it by.
 *
 * The semantics travel with the numbers; see `src/brand/size-guide.config.ts` for the full
 * statement. No size recommendation, size calculator, fit vocabulary or per-product measurement
 * mapping outside the approved tables may be authored or inferred.
 */
export const PUBLIC_SIZE_GUIDE = SIZE_GUIDE;

/** The approved apparel manufacturing tolerance, formatted for a reader. */
export function describePublicSizeTolerance(): string {
  return `±${PUBLIC_SIZE_GUIDE.toleranceCm} cm`;
}

