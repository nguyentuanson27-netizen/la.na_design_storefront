/**
 * Operator-facing feedback for the promotion admin surface.
 *
 * The admin UI is a thin client over the P4 service: it holds no pricing, overlap, lifecycle,
 * coverage or activation authority. What it does own is the translation from the service's typed
 * failures into something an operator can act on — and the discipline of saying nothing they
 * cannot. No SQL, no driver codes, no table or constraint names, no campaign or variant ids.
 *
 * The two admin bounds the spec names live here rather than in the activation service, because
 * they bound *listing and search* and there was no listing operation until this unit.
 */

import type { ActivationFailure } from "./promotion-activation-service.ts";

/** Server-authoritative page size for the admin campaign list. */
export const MAX_ADMIN_PROMOTION_PAGE_SIZE = 50;

/** Server-authoritative cap on target-search results. */
export const ADMIN_TARGET_SEARCH_LIMIT = 50;

function clampToBound(requested: number, bound: number): number {
  // Nonsense clamps to the bound rather than to zero: an empty screen reads as "no campaigns
  // exist", which is a different and misleading statement.
  if (!Number.isSafeInteger(requested) || requested < 1) return bound;
  return Math.min(requested, bound);
}

export function parseAdminPromotionPageSize(requested: number): number {
  return clampToBound(requested, MAX_ADMIN_PROMOTION_PAGE_SIZE);
}

export function parseAdminTargetSearchLimit(requested: number): number {
  return clampToBound(requested, ADMIN_TARGET_SEARCH_LIMIT);
}

/** A failure the admin surface can render, including the one this unit adds. */
export type PromotionAdminFailure =
  | ActivationFailure
  | { reason: "DUPLICATE_TARGET" }
  | { reason: "MALFORMED_FIXED_PRICE" }
  | { reason: "INVALID_PERCENTAGE" }
  | { reason: "INVALID_CAMPAIGN_KIND" }
  | { reason: "INVALID_DISCOUNT_TYPE" }
  | { reason: "INVALID_DATE_TIME" }
  /** The caller was not an admin when the Server Action re-checked. */
  | { reason: "FORBIDDEN" };

export type PromotionFailureDescription = Readonly<{
  reason: PromotionAdminFailure["reason"];
  message: string;
  /** True when the service refused before writing anything, so a retry changes nothing by itself. */
  wroteNothing: boolean;
}>;

const MESSAGES: Record<PromotionAdminFailure["reason"], string> = {
  PROMOTION_PRICE_UNSAFE: "Giá niêm yết hoặc giá chiến dịch không an toàn. Hãy kiểm tra các biến thể trước khi kích hoạt.",
  ACTIVATION_DISABLED:
    "Chức năng kích hoạt khuyến mãi đang tắt trên máy chủ. Không có thay đổi nào được lưu.",
  CAMPAIGN_NOT_FOUND: "Không tìm thấy chiến dịch. Có thể chiến dịch đã bị thay đổi ở nơi khác.",
  ILLEGAL_TRANSITION:
    "Trạng thái hiện tại của chiến dịch không cho phép thao tác này. Hãy tải lại trang để xem trạng thái mới nhất.",
  INVALID_CAMPAIGN:
    "Cấu hình chiến dịch chưa hợp lệ. Hãy kiểm tra lại giảm giá, thời gian và danh sách áp dụng.",
  INVALID_DRAFT_INPUT: "Dữ liệu nhập vượt quá giới hạn cho phép. Hãy rút ngắn và thử lại.",
  TARGET_EXPANSION_LIMIT_EXCEEDED:
    "Chiến dịch đang bao phủ quá nhiều phiên bản sản phẩm để có thể kích hoạt an toàn.",
  NO_EFFECTIVE_DISCOUNT:
    "Chiến dịch không tạo ra mức giá thấp hơn cho các phiên bản đang áp dụng.",
  UNUSABLE_BASE_PRICE:
    "Một số phiên bản sản phẩm chưa có giá gốc hợp lệ, nên chưa thể kích hoạt chiến dịch.",
  OVERLAPPING_CAMPAIGN:
    "Khoảng thời gian này trùng với một chiến dịch khác đang bật trên cùng phiên bản sản phẩm.",
  DUPLICATE_TARGET: "Danh sách áp dụng đang bị trùng. Mỗi sản phẩm hoặc phiên bản chỉ được chọn một lần.",
  MALFORMED_FIXED_PRICE: "Giá cố định không hợp lệ. Vui lòng nhập số tiền nguyên dương bằng VNĐ.",
  INVALID_PERCENTAGE: "Mức giảm phần trăm không hợp lệ. Vui lòng nhập số nguyên từ 1% đến 99%.",
  INVALID_CAMPAIGN_KIND: "Loại chiến dịch không hợp lệ.",
  INVALID_DISCOUNT_TYPE: "Hình thức giảm giá không hợp lệ.",
  INVALID_DATE_TIME: "Thời gian không hợp lệ. Vui lòng nhập ngày giờ theo định dạng hợp lệ.",
  FORBIDDEN: "Bạn không có quyền thực hiện thao tác này.",
};

export function describePromotionFailure(
  failure: PromotionAdminFailure,
): PromotionFailureDescription {
  return Object.freeze({
    reason: failure.reason,
    // Deliberately keyed on the reason alone. Interpolating the failure's payload is how ids and
    // internal detail reach a screen — and an operator fixes these from the form, not from a cuid.
    message: MESSAGES[failure.reason],
    // Every one of these is refused before commit, or rolled back by the transaction.
    wroteNothing: true,
  });
}

type DriverErrorShape = Readonly<{
  code?: unknown;
  meta?: { modelName?: unknown; target?: unknown };
}>;

/**
 * Recognises the one database failure the admin surface can describe better than the driver can:
 * a duplicate explicit target, refused by the unique constraint.
 *
 * Checkpoint A recorded this as fail-closed but untyped — the transaction rolls back and the
 * pricing revision is untouched, but the operator saw a raw driver error. Anything not recognised
 * returns `null` and is re-thrown by the caller: turning an unknown fault into "duplicate target"
 * would hide a genuine outage behind a form-validation message.
 */
export function translatePromotionWriteError(error: unknown): { reason: "DUPLICATE_TARGET" } | null {
  if (typeof error !== "object" || error === null) return null;

  const { code, meta } = error as DriverErrorShape;
  if (code !== "P2002") return null;
  if (meta?.modelName !== "PromotionTarget") return null;

  return { reason: "DUPLICATE_TARGET" };
}
