import { BRAND } from "./brand.config.ts";
import type { FulfillmentConfig } from "./schema.ts";

const NAME = BRAND.identity.name;

/**
 * Returns, delivery and return-logistics facts, as the owner approved them.
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
      "Khách hàng mua đúng hàng nhưng muốn đổi size hoặc đổi màu.",
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
      "Hoàn tiền cho đơn COD có thể thực hiện qua chuyển khoản ngân hàng hoặc phương thức phù hợp được thống nhất với khách hàng.",
  },

  // B4/§5 — delivery. NOT the shipping price: that stays with readGuestShippingPolicy, which B4
  // keeps as the pricing authority because production may legitimately override it. Duplicating a
  // fee here is how a page starts contradicting checkout.
  delivery: {
    coverage: "Giao hàng toàn quốc",
    carriers: ["GHN", "GHTK"],
    estimateDays: {
      innerCity: { minimum: 1, maximum: 3 },
      otherProvince: { minimum: 3, maximum: 15 },
    },
    // The estimates are estimates. §5 says so outright, and the page has to read that way: a
    // delivery window presented as a promise is a policy the owner did not make.
    estimateCaveat: "Đây là thời gian dự kiến, không phải cam kết thời hạn tuyệt đối.",
    carrierTrackingNote: `${NAME} không cung cấp mã vận đơn hoặc link theo dõi của đơn vị vận chuyển theo mặc định.`,
    phoneConfirmationWording: `${NAME} có thể liên hệ để xác minh đơn hàng khi cần.`,
  },

  // Human-facing labels for the delivery windows above. The detailed ward-level operational mapping
  // stays in the owner-decision document; the public policy only needs to tell a buyer which of the
  // two approved scopes applies. These stop /shipping collapsing the facts into the ambiguous
  // historical labels "Nội thành" and "Ngoại tỉnh".
  deliveryScopeLabels: {
    innerCity: "Nội thành Hà Nội",
    otherProvince: "Ngoài nội thành Hà Nội / các tỉnh, thành khác",
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
      "Sản phẩm đúng, không lỗi không được trả hàng để hoàn tiền; khách hàng chỉ được đổi hàng theo chính sách đổi mẫu / size / màu hiện hành.",
  },
};
