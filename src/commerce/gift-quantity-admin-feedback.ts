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
  INVALID_SCOPE_MODE: "Kiểu phạm vi áp dụng không hợp lệ.",
  INVALID_GIFT_TRIGGER: "Điều kiện nhận quà không hợp lệ.",
  INVALID_SUBTOTAL_SCOPE: "Phạm vi tính giá trị đơn hàng không hợp lệ.",
  INVALID_DATE_TIME: "Thời gian không hợp lệ. Vui lòng nhập ngày giờ theo định dạng hợp lệ.",
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
