import { BRAND, SIZE_GUIDE } from "../brand/index.ts";
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
 * B1/§4 — the returns, exchange and refund policy the owner approved, transcribed.
 *
 * Policy is the one kind of content a coding agent must never author, so every clause a page shows
 * is a member of this constant. A page that renders `productConditions` cannot quietly grow a
 * condition the owner never wrote, and a reviewer comparing this file to §4 is comparing like with
 * like rather than reading prose for omissions.
 *
 * `nonReturnableCategories` is deliberately an empty array rather than an absent key: §4 states
 * there is **no** separate excluded-category list, which is a decision, not a gap.
 */
export const PUBLIC_RETURNS_POLICY = Object.freeze({
  windowDays: 15,
  productConditions: Object.freeze([
    "còn mới",
    "chưa qua sử dụng",
    "còn đầy đủ tem/mác",
    "không rách, bẩn, hư hỏng",
    "không có mùi lạ",
    "không có dấu hiệu đã qua sử dụng",
    "đúng sản phẩm được mua từ LA Clothing",
    "gửi lại theo hướng dẫn của bộ phận hỗ trợ",
  ]),
  supportedCases: Object.freeze([
    "Sản phẩm lỗi hoặc có vết bẩn từ phía sản xuất.",
    "LA Clothing giao sai mẫu.",
    "Giao sai màu.",
    "Giao sai size.",
    "Khách hàng chủ động đổi sang mẫu khác.",
    "Khách hàng mua đúng hàng nhưng muốn đổi size hoặc đổi màu.",
  ]),
  customerInitiatedExchangeFeeVnd: 50_000,
  // Who bears the shipping in each case is a normative B1 commitment, not presentation copy. Left
  // as page prose it could drift from §4 while a test still called the constant faithful.
  customerInitiatedShippingNote: "Khách hàng chịu phí vận chuyển hai chiều.",
  shopFaultShippingNote: "LA Clothing chịu toàn bộ phí vận chuyển hợp lý cho việc đổi/trả.",
  nonReturnableCategories: Object.freeze([]),
  /**
   * What an empty `nonReturnableCategories` *means*, so the page can render the state rather than
   * assert it. §4 says there is no separate excluded-category list and only the stated rejection
   * conditions apply — a claim strong enough that it must not live in page prose.
   */
  nonReturnableCategoriesNote:
    "Không có danh mục sản phẩm loại trừ riêng. LA Clothing chỉ áp dụng các điều kiện từ chối đã nêu trong chính sách này.",
  refundWorkingDays: Object.freeze({ minimum: 7, maximum: 10 }),
  /**
   * §3 states the refund channel for a COD order. It lives with the refund policy rather than in a
   * payment constant: a way to receive money back is not a way to pay for an order, and both the
   * Returns and the Shipping page read this one string.
   */
  refundChannelNote:
    "Hoàn tiền cho đơn COD có thể thực hiện qua chuyển khoản ngân hàng hoặc phương thức phù hợp được thống nhất với khách hàng.",
});

/**
 * B4/§5 — the delivery facts the owner approved. **Not** the shipping price: that stays with
 * `readGuestShippingPolicy`, which B4 keeps as the pricing authority because production may
 * legitimately override it. Duplicating a fee here is how a page starts contradicting checkout.
 *
 * The estimates are estimates. §5 says so outright — "không phải guaranteed SLA tuyệt đối" — and the
 * page has to read that way, because a delivery window presented as a promise is a policy the owner
 * did not make.
 */
export const PUBLIC_DELIVERY_FACTS = Object.freeze({
  coverage: "Giao hàng toàn quốc",
  carriers: Object.freeze(["GHN", "GHTK"]),
  estimateDays: Object.freeze({
    innerCity: Object.freeze({ minimum: 1, maximum: 3 }),
    otherProvince: Object.freeze({ minimum: 3, maximum: 15 }),
  }),
  estimateCaveat: "Đây là thời gian dự kiến, không phải cam kết thời hạn tuyệt đối.",
  /**
   * §5: no carrier tracking number or link is provided by default, and a verification call is
   * possible but not required.
   *
   * Both are stored as the sentence the page renders rather than as a boolean beside hard-coded
   * copy. A flag that no rendering reads is how a fact changes here while the page keeps saying the
   * old thing.
   */
  carrierTrackingNote:
    "LA Clothing không cung cấp mã vận đơn hoặc link theo dõi của đơn vị vận chuyển theo mặc định.",
  phoneConfirmationWording: "LA Clothing có thể liên hệ để xác minh đơn hàng khi cần.",
});

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
  return `${minimum}–${maximum} ngày làm việc kể từ khi LA Clothing nhận lại sản phẩm, kiểm tra và xác nhận đủ điều kiện hoàn tiền`;
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

