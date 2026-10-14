/**
 * Operator-facing feedback for the gift / quantity-tier admin surface (GQ05).
 *
 * Keyed on the typed reason alone, like `promotion-admin-feedback.ts`: nothing from a failure's
 * payload (ids, constraint names, product ids) is interpolated into a sentence, so no internal
 * detail reaches a screen and a hand-edited URL cannot put arbitrary text on one. Where a payload
 * *code* (an enum from this domain, never free text) refines the sentence, it selects between
 * fixed strings.
 */

import type { GiftQuantityAdminFailure } from "./gift-quantity-admin-service.ts";
import type { GiftQuantityActivationFailure } from "./gift-quantity-activation-service.ts";
import type { GiftQuantityDraftParseReason } from "./gift-quantity-admin-input.ts";

export type GiftQuantityFailure =
  | GiftQuantityAdminFailure
  | GiftQuantityActivationFailure
  | { reason: GiftQuantityDraftParseReason }
  | { reason: "FORBIDDEN" };

export type GiftQuantityFailureDescription = Readonly<{
  reason: GiftQuantityFailure["reason"];
  message: string;
  /** Every refusal happens before commit or is rolled back, so a retry changes nothing by itself. */
  wroteNothing: true;
}>;

const BASE_MESSAGES: Record<GiftQuantityFailure["reason"], string> = {
  FEATURE_DISABLED:
    "Tính năng quà tặng và giảm giá theo số lượng đang tắt trên máy chủ. Bạn vẫn có thể soạn nháp, nhưng chưa thể bật chiến dịch. Không có thay đổi nào được lưu.",
  CAMPAIGN_NOT_FOUND: "Không tìm thấy chiến dịch. Có thể chiến dịch đã bị thay đổi ở nơi khác.",
  ILLEGAL_TRANSITION:
    "Trạng thái hiện tại của chiến dịch không cho phép thao tác này. Hãy tải lại trang để xem trạng thái mới nhất.",
  INVALID_INPUT: "Dữ liệu nhập chưa hợp lệ. Hãy kiểm tra lại tên, thời gian và các lựa chọn rồi thử lại.",
  INVALID_SCOPE: "Phạm vi áp dụng chưa hợp lệ. Hãy kiểm tra lại danh mục, sản phẩm áp dụng và sản phẩm loại trừ.",
  INVALID_RULE:
    "Quy tắc của chiến dịch chưa hoàn thiện hoặc chưa được hỗ trợ xuất bản, nên chưa thể bật. Không có thay đổi nào được lưu.",
  FROZEN_SET_INVALID: "Không thể chốt danh sách sản phẩm cho chiến dịch này.",
  KIND_IMMUTABLE: "Không thể đổi loại chiến dịch sau khi đã tạo. Hãy tạo chiến dịch mới.",
  INVALID_KIND: "Loại chiến dịch không hợp lệ.",
  TIER_FIELDS_ON_GIFT: "Chiến dịch quà tặng không có bậc giảm giá theo số lượng.",
  INVALID_SCOPE_MODE: "Kiểu phạm vi áp dụng không hợp lệ.",
  INVALID_GIFT_TRIGGER: "Điều kiện nhận quà không hợp lệ.",
  INVALID_SUBTOTAL_SCOPE: "Phạm vi tính giá trị đơn hàng không hợp lệ.",
  INVALID_DATE_TIME: "Thời gian không hợp lệ. Vui lòng nhập ngày giờ theo định dạng hợp lệ.",
  INVALID_TIER_UNIT: "Đơn vị giảm giá không hợp lệ.",
  INVALID_TIER_DISCOUNTED_UNITS: "Cách áp dụng giảm giá không hợp lệ.",
  INVALID_TIER_SELECTION_PRIORITY: "Thứ tự chọn sản phẩm được giảm không hợp lệ.",
  INVALID_TIER_ROW: "Có bậc giảm giá chưa hợp lệ: số lượng và mức giảm phải là số nguyên dương và nhập đủ cả hai.",
  INVALID_STACKING_FLAG: "Lựa chọn cho phép cộng dồn không hợp lệ.",
  INVALID_STACK_PRIORITY: "Mức ưu tiên cộng dồn phải là số nguyên không âm.",
  INVALID_STACK_PEER: "Có chiến dịch cộng dồn chưa hợp lệ.",
  GIFT_FIELDS_ON_TIER: "Chiến dịch giảm giá theo số lượng không có điều kiện nhận quà.",
  INVALID_GIFT_MINIMUM_QUANTITY: "Số lượng tối thiểu để nhận quà phải là số nguyên dương.",
  INVALID_GIFT_MINIMUM_SUBTOTAL: "Giá trị đơn hàng tối thiểu để nhận quà phải là số nguyên dương (đồng).",
  INVALID_GIFT_AWARD_MODE: "Cách tặng quà không hợp lệ.",
  INVALID_GIFT_MAX_PER_ORDER: "Số quà tối đa mỗi đơn phải là số nguyên dương.",
  INVALID_GIFT_DUPLICATE_FLAG: "Lựa chọn cho phép tặng trùng quà không hợp lệ.",
  INVALID_GIFT_VARIANT: "Danh sách quà tặng có phiên bản sản phẩm chưa hợp lệ hoặc quá dài.",
  FORBIDDEN: "Bạn không có quyền thực hiện thao tác này.",
};

const INVALID_INPUT_REFINEMENTS: Readonly<Record<string, string>> = {
  EMPTY_NAME: "Tên chiến dịch không được để trống.",
  NAME_TOO_LONG: "Tên chiến dịch quá dài (tối đa 120 ký tự).",
  UNSUPPORTED_NAME_CHARACTER: "Tên chiến dịch chứa ký tự không được hỗ trợ.",
  GLOBAL_SCOPE_NOT_ALLOWED:
    "Phạm vi toàn đơn chỉ dùng cho quà tặng theo giá trị đơn hàng tính trên tất cả sản phẩm trả tiền.",
  SUBTOTAL_SCOPE_MISMATCH:
    "Phạm vi tính giá trị không khớp với kiểu phạm vi: “Tất cả dòng trả tiền” dùng phạm vi toàn đơn, còn “Chỉ dòng thuộc phạm vi” cần chọn danh mục hoặc sản phẩm.",
  GIFT_FIELDS_ON_TIER: "Chiến dịch giảm giá theo số lượng không có điều kiện nhận quà.",
  KIND_IMMUTABLE: "Không thể đổi loại chiến dịch sau khi đã tạo. Hãy tạo chiến dịch mới.",
  GIFT_TRIGGER_NOT_EDITABLE_WHEN_SCHEDULED:
    "Không thể đổi điều kiện nhận quà khi chiến dịch đã lên lịch, vì các mốc đã nhập sẽ đổi nghĩa. Hãy tắt chiến dịch rồi sao chép thành bản nháp mới để đổi điều kiện.",
  IDENTIFIER_TOO_LONG: "Mã chiến dịch không hợp lệ.",
  WINDOW_NOT_POSITIVE: "Thời gian kết thúc phải sau thời gian bắt đầu.",
  WINDOW_ALREADY_ENDED: "Thời gian kết thúc đã qua.",
  INVALID_NAME: "Tên chiến dịch không hợp lệ.",
  TIER_FIELDS_ON_GIFT: "Chiến dịch quà tặng không có bậc giảm giá theo số lượng.",
  TIERS_TOO_MANY: "Có quá nhiều bậc giảm giá.",
  TIER_THRESHOLD_OUT_OF_RANGE: "Số lượng của bậc giảm giá nằm ngoài giới hạn cho phép.",
  TIER_VALUE_OUT_OF_RANGE: "Mức giảm của bậc nằm ngoài giới hạn cho phép.",
  TIER_PERCENT_OUT_OF_RANGE: "Giảm theo phần trăm phải từ 1% đến 99%.",
  TIER_THRESHOLD_DUPLICATE: "Có hai bậc giảm giá trùng số lượng.",
  TIER_UNIT_REQUIRED: "Hãy chọn đơn vị giảm giá (phần trăm hoặc số tiền cố định mỗi sản phẩm).",
  SELECTION_PRIORITY_NOT_APPLICABLE: "Thứ tự chọn sản phẩm chỉ dùng khi chỉ giảm từ mốc đạt được.",
  STACK_PRIORITY_OUT_OF_RANGE: "Mức ưu tiên cộng dồn nằm ngoài giới hạn cho phép.",
  STACK_PEERS_TOO_MANY: "Có quá nhiều chiến dịch cộng dồn.",
  STACK_PEER_INVALID: "Có chiến dịch cộng dồn chưa hợp lệ.",
  STACK_PEER_DUPLICATE: "Có chiến dịch cộng dồn bị trùng.",
  STACK_PEER_SELF: "Chiến dịch không thể cộng dồn với chính nó.",
  STACK_PEER_UNKNOWN: "Có chiến dịch cộng dồn không tồn tại hoặc không đúng loại.",
  STACK_FIELDS_CONFLICT: "Mức ưu tiên hoặc lựa chọn cộng dồn không khớp với cấu hình bậc giảm giá.",
  GIFT_MINIMUM_QUANTITY_OUT_OF_RANGE: "Số lượng tối thiểu để nhận quà nằm ngoài giới hạn cho phép.",
  GIFT_MINIMUM_SUBTOTAL_OUT_OF_RANGE: "Giá trị đơn hàng tối thiểu để nhận quà nằm ngoài giới hạn cho phép.",
  INVALID_GIFT_AWARD_MODE: "Cách tặng quà không hợp lệ.",
  GIFT_MAX_PER_ORDER_OUT_OF_RANGE: "Số quà tối đa mỗi đơn nằm ngoài giới hạn cho phép (1 đến 100).",
  INVALID_GIFT_DUPLICATE_FLAG: "Lựa chọn cho phép tặng trùng quà không hợp lệ.",
  GIFT_OPTIONS_TOO_MANY: "Danh sách quà tặng có quá nhiều phiên bản sản phẩm.",
  GIFT_OPTION_INVALID: "Danh sách quà tặng có phiên bản sản phẩm không hợp lệ.",
  GIFT_OPTION_DUPLICATE: "Danh sách quà tặng có phiên bản sản phẩm bị trùng.",
  GIFT_TRIGGER_REQUIRED_FOR_THRESHOLD: "Hãy chọn điều kiện nhận quà trước khi nhập mốc số lượng hoặc giá trị.",
  GIFT_FIELD_NOT_APPLICABLE:
    "Có trường không thuộc điều kiện nhận quà đã chọn: mua đủ số lượng chỉ dùng số lượng tối thiểu, còn theo giá trị đơn hàng dùng giá trị tối thiểu và cách tặng.",
  GIFT_VARIANT_UNKNOWN: "Có phiên bản sản phẩm trong danh sách quà tặng không tồn tại.",
};

const INVALID_SCOPE_REFINEMENTS: Readonly<Record<string, string>> = {
  "scope-global-with-targets":
    "Phạm vi toàn đơn không được kết hợp với danh mục hoặc danh sách sản phẩm. Hãy bỏ các lựa chọn đó hoặc chọn phạm vi theo danh mục.",
  "scope-global-not-allowed":
    "Phạm vi toàn đơn chỉ dùng cho quà tặng theo giá trị đơn hàng tính trên tất cả sản phẩm trả tiền.",
  "scope-category-unknown": "Có danh mục không tồn tại trong hệ thống.",
  "scope-category-too-many": "Đã chọn quá nhiều danh mục.",
  "scope-included-too-many": "Danh sách sản phẩm áp dụng vượt quá giới hạn cho phép.",
  "scope-excluded-too-many": "Danh sách sản phẩm loại trừ vượt quá giới hạn cho phép.",
  "scope-product-id-invalid": "Có sản phẩm không hợp lệ hoặc không tồn tại trong danh sách.",
  "scope-duplicate-entry": "Danh sách đang có mục bị trùng.",
  "scope-mode-invalid": "Kiểu phạm vi áp dụng không hợp lệ.",
  "scope-empty": "Hãy chọn ít nhất một danh mục hoặc sản phẩm áp dụng.",
};

const FROZEN_REFINEMENTS: Readonly<Record<string, string>> = {
  "scope-frozen-empty": "Không có sản phẩm nào khớp với danh mục và sản phẩm đã chọn, nên không có gì để chốt danh sách.",
  "scope-frozen-too-many": "Có quá nhiều sản phẩm khớp để chốt danh sách an toàn. Hãy thu hẹp danh mục hoặc thêm loại trừ.",
};

const INVALID_RULE_REFINEMENTS: Readonly<Record<string, string>> = {
  RULE_VALIDATION_NOT_AVAILABLE: BASE_MESSAGES.INVALID_RULE,
  TIER_CONFIG_INCOMPLETE: "Hãy chọn đơn vị giảm giá và cách áp dụng (toàn bộ hoặc từ mốc đạt được) trước khi bật.",
  TIERS_EMPTY: "Cần ít nhất một bậc giảm giá trước khi bật.",
  TIERS_TOO_MANY: "Có quá nhiều bậc giảm giá.",
  THRESHOLD_INVALID: "Số lượng của một bậc giảm giá không hợp lệ.",
  THRESHOLD_NOT_STRICTLY_INCREASING: "Số lượng các bậc phải tăng dần, không trùng nhau.",
  VALUE_INVALID: "Mức giảm của một bậc không hợp lệ.",
  VALUE_DECREASES_WITH_THRESHOLD: "Mức giảm không được thấp đi khi số lượng tăng lên.",
  SELECTION_PRIORITY_REQUIRED: "Hãy chọn thứ tự chọn sản phẩm được giảm (rẻ nhất hoặc đắt nhất trước).",
  SELECTION_PRIORITY_NOT_APPLICABLE: "Thứ tự chọn sản phẩm chỉ dùng khi chỉ giảm từ mốc đạt được.",
  UNIT_INVALID: "Đơn vị giảm giá không hợp lệ.",
  DISCOUNTED_UNITS_INVALID: "Cách áp dụng giảm giá không hợp lệ.",
  STACK_PRIORITY_REQUIRED: "Cộng dồn đang bật nên cần nhập mức ưu tiên.",
  STACK_PEERS_REQUIRED: "Cộng dồn đang bật nên cần chọn ít nhất một chiến dịch được cộng dồn.",
  STACK_PRIORITY_CONFLICT: "Mức ưu tiên cộng dồn đã được chiến dịch đang hoạt động khác sử dụng. Hãy chọn mức khác.",
  STACK_PEER_SELF: "Chiến dịch không thể cộng dồn với chính nó.",
  STACK_PEER_UNKNOWN: "Có chiến dịch cộng dồn không tồn tại hoặc không đúng loại.",
  TIER_PRICE_ELIGIBILITY_UNRESOLVED: "Không thể xác minh đầy đủ giá của sản phẩm thành phần trong phạm vi. Hãy thu hẹp phạm vi rồi thử lại.",
  TIER_PRICE_BELOW_MINIMUM:
    "Mức giảm cố định làm giá của một số sản phẩm trong phạm vi xuống dưới 1đ. Hãy giảm mức giảm hoặc thu hẹp phạm vi.",
  GIFT_TRIGGER_REQUIRED: "Hãy chọn điều kiện nhận quà (mua đủ số lượng hoặc đạt giá trị đơn hàng) trước khi bật.",
  GIFT_MINIMUM_QUANTITY_REQUIRED: "Hãy nhập số lượng tối thiểu để nhận quà trước khi bật.",
  GIFT_MINIMUM_SUBTOTAL_REQUIRED: "Hãy nhập giá trị đơn hàng tối thiểu để nhận quà trước khi bật.",
  GIFT_AWARD_MODE_REQUIRED: "Hãy chọn cách tặng quà (một lần hoặc lặp lại theo mốc) trước khi bật.",
  GIFT_SUBTOTAL_SCOPE_REQUIRED: "Hãy chọn phạm vi tính giá trị đơn hàng trước khi bật.",
  GIFT_DUPLICATE_POLICY_REQUIRED: "Hãy chọn có cho phép tặng trùng quà hay không trước khi bật.",
  GIFT_OPTIONS_EMPTY: "Cần ít nhất một quà trong danh sách quà tặng trước khi bật.",
  GIFT_VARIANT_UNKNOWN: "Có phiên bản sản phẩm trong danh sách quà tặng không tồn tại.",
  GIFT_VARIANT_UNAVAILABLE: "Có quà trong danh sách đang ngừng bán hoặc không còn trong kho dữ liệu. Hãy bỏ quà đó.",
  GIFT_VARIANT_COMPOSITE: "Quà dạng combo chưa được hỗ trợ làm quà tặng. Hãy chọn phiên bản sản phẩm thường.",
  GIFT_NO_READY_STOCK: "Không có quà nào trong danh sách còn hàng sẵn sàng để tặng. Hãy bổ sung hàng hoặc đổi quà.",
  GIFT_MINIMUM_QUANTITY_OUT_OF_RANGE: "Số lượng tối thiểu để nhận quà nằm ngoài giới hạn cho phép.",
  GIFT_MINIMUM_SUBTOTAL_OUT_OF_RANGE: "Giá trị đơn hàng tối thiểu để nhận quà nằm ngoài giới hạn cho phép.",
  GIFT_MAX_PER_ORDER_OUT_OF_RANGE: "Số quà tối đa mỗi đơn nằm ngoài giới hạn cho phép (1 đến 100).",
  GIFT_FIELD_NOT_APPLICABLE: "Có trường không thuộc điều kiện nhận quà đã chọn.",
};

export function describeGiftQuantityFailure(failure: GiftQuantityFailure): GiftQuantityFailureDescription {
  let message = BASE_MESSAGES[failure.reason];
  if (failure.reason === "INVALID_INPUT") {
    message = INVALID_INPUT_REFINEMENTS[failure.errors[0] ?? ""] ?? message;
  } else if (failure.reason === "INVALID_SCOPE") {
    message = INVALID_SCOPE_REFINEMENTS[failure.issues[0]?.code ?? ""] ?? message;
  } else if (failure.reason === "FROZEN_SET_INVALID") {
    message = FROZEN_REFINEMENTS[failure.code] ?? message;
  } else if (failure.reason === "INVALID_RULE") {
    message = INVALID_RULE_REFINEMENTS[failure.errors[0] ?? ""] ?? message;
  }
  return Object.freeze({ reason: failure.reason, message, wroteNothing: true as const });
}

/** The reasons the admin page will render from the URL; anything else falls back to a generic sentence. */
export const GIFT_QUANTITY_RENDERABLE_REASONS: ReadonlySet<string> = new Set(Object.keys(BASE_MESSAGES));

export function describeGiftQuantityReason(reason: string): string | null {
  return GIFT_QUANTITY_RENDERABLE_REASONS.has(reason)
    ? BASE_MESSAGES[reason as GiftQuantityFailure["reason"]]
    : null;
}
