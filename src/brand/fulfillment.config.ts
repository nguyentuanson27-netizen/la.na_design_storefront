import { BRAND } from "./brand.config.ts";
import type { FulfillmentConfig } from "./schema.ts";

const NAME = BRAND.identity.name;

/**
 * Returns, delivery, payment and support facts, as the owner approved them.
 *
 * Master spec PART D is the normalized, override-applied form of the supplied terms document, and
 * this file transcribes it. There is deliberately no second policy document: a competing authority
 * is a copy that drifts.
 *
 * Policy is the one kind of content a coding agent must never author, so every clause a page shows
 * is a member of this config. A page that renders `returns.productConditions` cannot quietly grow a
 * condition the owner never wrote, and a reviewer comparing this file to the approved document is
 * comparing like with like rather than reading prose for omissions.
 *
 * Sentences that name the shop interpolate `BRAND.identity.name` rather than spelling it out. The
 * rendered text is unchanged; what changes is that a fork renames itself in one place instead of
 * hunting through policy prose — the same single-source rule the rest of Brand Config follows.
 */
export const FULFILLMENT: FulfillmentConfig = {
  // B1/§4 — returns, exchange and refund.
  returns: {
    windowDays: 15,
    productConditions: [
      "còn mới",
      "chưa qua sử dụng",
      "còn đầy đủ tem/mác",
      "không rách, bẩn, hư hỏng",
      "không có mùi lạ",
      "không có dấu hiệu đã qua sử dụng",
      `đúng sản phẩm được mua từ ${NAME}`,
      "gửi lại theo hướng dẫn của bộ phận hỗ trợ",
    ],
    supportedCases: [
      "Sản phẩm lỗi hoặc có vết bẩn từ phía sản xuất.",
      `${NAME} giao sai mẫu.`,
      "Giao sai màu.",
      "Giao sai size.",
      "Khách hàng chủ động đổi sang mẫu khác.",
      // §13 lists exactly these five. Brand #1 also promised an exchange of size or colour on an
      // order the shop fulfilled correctly; the approved source does not support it, so it is
      // dropped rather than carried over because it was already here.
    ],
    customerInitiatedExchangeFeeVnd: 50_000,
    // Who bears the shipping in each case is a normative B1 commitment, not presentation copy. Left
    // as page prose it could drift from §4 while a test still called the constant faithful.
    customerInitiatedShippingNote: "Khách hàng chịu phí vận chuyển hai chiều.",
    shopFaultShippingNote: `${NAME} chịu toàn bộ phí vận chuyển hợp lý cho việc đổi/trả.`,
    // Deliberately empty rather than absent: §4 states there is no separate excluded-category list,
    // which is a decision, not a gap.
    nonReturnableCategories: [],
    nonReturnableCategoriesNote: `Không có danh mục sản phẩm loại trừ riêng. ${NAME} chỉ áp dụng các điều kiện từ chối đã nêu trong chính sách này.`,
    refundWorkingDays: { minimum: 7, maximum: 10 },
    // §3 refund channel for a COD order. It lives with the refund policy rather than in a payment
    // constant: a way to receive money back is not a way to pay for an order.
    refundChannelNote:
      "Hoàn tiền ưu tiên thực hiện qua phương thức thanh toán ban đầu khi có thể; nếu không, qua chuyển khoản ngân hàng hoặc phương thức khác được thống nhất với khách hàng.",
  },

  // B4/§5 — delivery. NOT the shipping price: that stays with readGuestShippingPolicy, which B4
  // keeps as the pricing authority because production may legitimately override it. Duplicating a
  // fee here is how a page starts contradicting checkout.
  delivery: {
    coverage: "Giao hàng toàn quốc",
    carriers: ["GHN", "GHTK", "Viettel Post", "J&T"],
    carrierSelectionNote:
      "Đơn vị vận chuyển có thể thay đổi tùy theo đơn hàng và khu vực giao.",
    estimateDays: {
      innerCity: { minimum: 1, maximum: 3 },
      otherProvince: { minimum: 3, maximum: 10 },
    },
    // The estimates are estimates. §5 says so outright, and the page has to read that way: a
    // delivery window presented as a promise is a policy the owner did not make.
    estimateCaveat: "Đây là thời gian dự kiến, không phải cam kết thời hạn tuyệt đối.",
    carrierTrackingNote: `${NAME} không cung cấp mã vận đơn hoặc link theo dõi của đơn vị vận chuyển theo mặc định.`,
    phoneConfirmationWording: `${NAME} có thể liên hệ để xác minh đơn hàng khi cần.`,
  },

  // Human-facing labels for the delivery windows above. §12 splits the country in two: Hà Nội, and
  // everywhere else. The inherited labels narrowed the 1-3 day window to the city's inner districts
  // and framed the rest as "outside inner-city Hanoi", which is a different and smaller promise
  // than the one the owner approved.
  deliveryScopeLabels: {
    innerCity: "Hà Nội",
    otherProvince: "Tỉnh, thành khác",
  },

  returnLogistics: {
    returnMethods: {
      inStore: "Trả trực tiếp tại cửa hàng / địa điểm kinh doanh.",
      byMail: "Gửi trả qua đường vận chuyển / bưu gửi.",
      byMailResponsibility: "Khách hàng tự chịu trách nhiệm gửi hàng và nhãn/phiếu gửi trả.",
    },
    restockingFeeVnd: 0,
    restockingFeeNote: "Không thu phí restocking.",
    nonDefectiveRefundNote:
      "Sản phẩm đúng và không lỗi không được trả lại để hoàn tiền vì khách hàng đổi ý; khách hàng có thể đổi sang mẫu khác theo điều kiện đổi hàng hiện hành.",
  },

  // §14 — what the website can take today. The bank-transfer sentence is approved word for word.
  payment: {
    codNote: "Thanh toán khi nhận hàng (COD).",
    bankTransferUnavailableNote:
      "Chuyển khoản ngân hàng hiện tạm thời chưa khả dụng trên website.",
  },

  // §15 — the complaint-handling commitment. A response target is a promise, so it is a fact here
  // rather than a sentence a support page could soften.
  support: {
    complaintResponseNote: "24–48 giờ làm việc kể từ khi tiếp nhận đủ thông tin.",
  },
};

/**
 * Master spec §22 — the homepage service strip: exactly these three facts, and no fourth.
 *
 * Derived here, in Brand Config, from the authorities that already own each part: the return
 * window, the approved delivery-coverage wording and the support hours. Deriving rather than
 * retyping is what stops the homepage promising 15 days while `/returns` promises something else,
 * and keeping it in `src/brand` is what keeps the strings out of page markup.
 *
 * Not part of `buildPublicBrandFacts`: that projection's shape is pinned by the W13A historical
 * inventory, and a new homepage section is not a new W13A fact.
 */
export const HOME_SERVICE_FACTS: readonly string[] = Object.freeze([
  `Đổi trả trong ${FULFILLMENT.returns.windowDays} ngày`,
  FULFILLMENT.delivery.coverage,
  `Tư vấn size ${BRAND.contact.supportHours.opens}–${BRAND.contact.supportHours.closes}`,
]);
