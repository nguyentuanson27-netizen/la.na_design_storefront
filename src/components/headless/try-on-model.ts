import {
  TRY_ON_AGE_ADULT,
  TRY_ON_AGE_BELOW_CONSENT_AGE,
  TRY_ON_AGE_TEEN_WITH_GUARDIAN,
  TRY_ON_ALLOWED_IMAGE_MIME_TYPES,
  TRY_ON_MAX_IMAGE_BYTES,
  type TryOnAgeState,
  type TryOnFailureReason,
} from "../../commerce/try-on-policy.ts";

/**
 * What a shopper reads and what the browser may decide on its own for virtual try-on
 * (`docs/specs/storefront-virtual-try-on.md` §6, §10, §13).
 *
 * Pure, so it is tested without a browser. Nothing here is a gate: the server re-checks the file,
 * the acknowledgement and the age state before it contacts Vertex AI, and these helpers only keep
 * the form honest about what the server will accept.
 */

/** Re-exported so the markup layer reads policy text from headless, not from `@/commerce`. */
export { TRY_ON_LIKENESS_ACKNOWLEDGEMENT } from "../../commerce/try-on-policy.ts";
export type { TryOnAgeState, TryOnFailureReason } from "../../commerce/try-on-policy.ts";

export type TryOnAgeOption = Readonly<{ value: TryOnAgeState; label: string }>;

/**
 * The teen option names all three attestations the spec requires — the age range, the digital
 * consent age where the shopper lives, and parent/guardian permission — in one statement, so none
 * of them can be ticked without the others.
 */
export const TRY_ON_AGE_OPTIONS: readonly TryOnAgeOption[] = [
  { value: TRY_ON_AGE_ADULT, label: "Tôi từ 18 tuổi trở lên." },
  {
    value: TRY_ON_AGE_TEEN_WITH_GUARDIAN,
    label:
      "Tôi từ 13 đến 17 tuổi, đã đủ tuổi đồng ý xử lý dữ liệu số theo quy định nơi tôi sống và có sự cho phép của cha mẹ hoặc người giám hộ hợp pháp.",
  },
  {
    value: TRY_ON_AGE_BELOW_CONSENT_AGE,
    label: "Tôi chưa đủ tuổi đồng ý xử lý dữ liệu số tại nơi tôi sống.",
  },
];

export const TRY_ON_TEEN_DISCLOSURE =
  "Ảnh này do AI tạo ra nên có thể chưa chính xác. Đừng dùng ảnh này để đánh giá cơ thể của bạn hay để chọn size quần áo — hãy xem bảng size của sản phẩm.";

export const TRY_ON_BLOCKED_AGE_MESSAGE =
  "Tính năng thử đồ chưa dành cho bạn. Bạn vẫn có thể xem sản phẩm và đặt hàng bình thường.";

/** Shown for every outcome the shopper can see. None carries upstream detail. */
const FAILURE_COPY: Readonly<Record<TryOnFailureReason, string>> = {
  UNAVAILABLE: "Thử đồ tạm thời chưa dùng được. Bạn vẫn có thể chọn sản phẩm và đặt hàng bình thường.",
  INVALID_REQUEST: "Không gửi được yêu cầu. Vui lòng kiểm tra lại ảnh và thử lại.",
  LIKENESS_REQUIRED: "Vui lòng xác nhận quyền sử dụng hình ảnh trước khi tạo ảnh.",
  AGE_STATE_INVALID: "Vui lòng chọn độ tuổi của bạn trước khi tạo ảnh.",
  AGE_BLOCKED: "Tính năng thử đồ chưa dành cho bạn.",
  UNSUPPORTED_IMAGE: "Ảnh phải là tệp JPG hoặc PNG hợp lệ.",
  IMAGE_TOO_LARGE: "Ảnh vượt quá 7 MB. Vui lòng chọn ảnh nhỏ hơn.",
  NOT_ELIGIBLE: "Sản phẩm này hiện chưa hỗ trợ thử đồ.",
  PRODUCT_IMAGE_UNAVAILABLE: "Chưa lấy được ảnh sản phẩm để thử đồ. Vui lòng thử lại sau.",
  RATE_LIMITED: "Bạn đã thử nhiều lần liên tiếp. Vui lòng thử lại sau ít phút.",
  BUSY: "Hệ thống đang có nhiều yêu cầu. Vui lòng thử lại sau ít phút.",
  SAFETY_BLOCKED:
    "Không thể tạo ảnh từ ảnh này. Vui lòng chọn một ảnh khác: chính diện, rõ người, đủ sáng.",
  AUTH_FAILED: "Thử đồ tạm thời chưa dùng được. Bạn vẫn có thể chọn sản phẩm và đặt hàng bình thường.",
  TIMEOUT: "Tạo ảnh mất quá nhiều thời gian. Vui lòng thử lại.",
  GENERATION_FAILED: "Chưa tạo được ảnh thử đồ. Vui lòng thử lại.",
};

export const TRY_ON_NETWORK_FAILURE_MESSAGE = "Không kết nối được. Vui lòng kiểm tra mạng và thử lại.";

/** An unrecognised or missing reason is shown as a plain generation failure. */
export function tryOnFailureMessage(reason: unknown): string {
  return typeof reason === "string" && reason in FAILURE_COPY
    ? FAILURE_COPY[reason as TryOnFailureReason]
    : FAILURE_COPY.GENERATION_FAILED;
}

/** A provider safety block is final for that photo: the shopper must choose another. */
export function isFinalForPhoto(reason: unknown): boolean {
  return reason === "SAFETY_BLOCKED";
}

/** Convenience check only; the server validates type, signature and size again. */
export function validateTryOnFile(file: Readonly<{ type: string; size: number }>): string | null {
  if (!(TRY_ON_ALLOWED_IMAGE_MIME_TYPES as readonly string[]).includes(file.type)) {
    return FAILURE_COPY.UNSUPPORTED_IMAGE;
  }
  if (file.size > TRY_ON_MAX_IMAGE_BYTES) return FAILURE_COPY.IMAGE_TOO_LARGE;
  return null;
}

/** What is still missing before generation is possible, in the order a shopper fills it in. */
export function missingTryOnSteps({
  hasPhoto,
  ageState,
  acknowledged,
}: Readonly<{ hasPhoto: boolean; ageState: TryOnAgeState | null; acknowledged: boolean }>): string[] {
  const missing: string[] = [];
  if (!hasPhoto) missing.push("chọn ảnh");
  if (ageState === null) missing.push("chọn độ tuổi");
  if (!acknowledged) missing.push("xác nhận quyền sử dụng hình ảnh");
  return missing;
}

export function isTryOnAgeAllowed(ageState: TryOnAgeState | null): boolean {
  return ageState !== null && ageState !== TRY_ON_AGE_BELOW_CONSENT_AGE;
}

export function isTeenAgeState(ageState: TryOnAgeState | null): boolean {
  return ageState === TRY_ON_AGE_TEEN_WITH_GUARDIAN;
}

export function isBlockedAgeState(ageState: TryOnAgeState | null): boolean {
  return ageState === TRY_ON_AGE_BELOW_CONSENT_AGE;
}
