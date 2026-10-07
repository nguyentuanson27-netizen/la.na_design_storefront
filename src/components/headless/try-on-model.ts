import {
  TRY_ON_AGE_ADULT,
  TRY_ON_AGE_BELOW_CONSENT_AGE,
  TRY_ON_AGE_TEEN_WITH_GUARDIAN,
  TRY_ON_ALLOWED_IMAGE_MIME_TYPES,
  TRY_ON_GUEST_QUOTA,
  TRY_ON_MAX_IMAGE_BYTES,
  TRY_ON_MEMBER_QUOTA,
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

export type TryOnAgeOption = Readonly<{
  value: TryOnAgeState;
  /** The full statement the shopper is attesting to. */
  label: string;
  /** The compact chip text; it labels the choice but is never the thing attested to. */
  shortLabel: string;
}>;

/**
 * The teen option names all three attestations the spec requires — the age range, the digital
 * consent age where the shopper lives, and parent/guardian permission — in one statement, so none
 * of them can be ticked without the others.
 */
export const TRY_ON_AGE_OPTIONS: readonly TryOnAgeOption[] = [
  { value: TRY_ON_AGE_ADULT, label: "Tôi từ 18 tuổi trở lên.", shortLabel: "Từ 18 tuổi" },
  {
    value: TRY_ON_AGE_TEEN_WITH_GUARDIAN,
    label:
      "Tôi từ 13 đến 17 tuổi, đã đủ tuổi đồng ý xử lý dữ liệu số theo quy định nơi tôi sống và có sự cho phép của cha mẹ hoặc người giám hộ hợp pháp.",
    shortLabel: "13–17 tuổi",
  },
  {
    value: TRY_ON_AGE_BELOW_CONSENT_AGE,
    label: "Tôi chưa đủ tuổi đồng ý xử lý dữ liệu số tại nơi tôi sống.",
    shortLabel: "Chưa đủ tuổi",
  },
];

/**
 * Shown above the teen statement so a short chip is never mistaken for the attestation: choosing it
 * means the shopper is making the full statement beneath.
 */
export const TRY_ON_TEEN_ATTESTATION_LEAD = "Khi chọn mục này, bạn xác nhận:";

/**
 * The wizard's three steps: choose the photo, state age and confirm rights, see the result. Loading,
 * success and failure are all the `result` step, so the form behind it is not on screen — and not
 * editable — while a request is in flight.
 */
export type TryOnStep = "photo" | "confirm" | "result";
export type TryOnStepEvent = "continue" | "change-photo" | "generate" | "back" | "photo-dropped";

export const TRY_ON_STEP_COUNT = 3;

export function tryOnStepNumber(step: TryOnStep): 1 | 2 | 3 {
  return step === "photo" ? 1 : step === "confirm" ? 2 : 3;
}

/**
 * Where an event takes the shopper. Anything that does not make sense for the current step leaves it
 * unchanged, so the confirmation step cannot be skipped. A photo the provider refused is dropped
 * wherever the shopper is and sends them back to choose another.
 */
export function nextTryOnStep(step: TryOnStep, event: TryOnStepEvent): TryOnStep {
  if (event === "photo-dropped") return "photo";
  switch (step) {
    case "photo":
      return event === "continue" ? "confirm" : step;
    case "confirm":
      if (event === "generate") return "result";
      return event === "change-photo" ? "photo" : step;
    case "result":
      if (event === "back") return "confirm";
      return event === "change-photo" ? "photo" : step;
  }
}

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
  RATE_LIMITED: "Bạn vừa thử đồ xong. Mỗi lượt thử đồ cách nhau khoảng 1 phút — vui lòng chờ rồi thử lại.",
  LOGIN_REQUIRED: `Bạn đã dùng hết ${TRY_ON_GUEST_QUOTA.perDay} lượt thử đồ miễn phí hôm nay. Đăng ký tài khoản hoặc đăng nhập để thử tiếp.`,
  DAILY_LIMIT_REACHED: `Bạn đã dùng hết ${TRY_ON_MEMBER_QUOTA.perDay} lượt thử đồ hôm nay. Lượt thử được làm mới sau 24 giờ kể từ lượt đầu tiên — mời bạn quay lại sau.`,
  BUSY: "Hệ thống đang có nhiều yêu cầu. Vui lòng thử lại sau ít phút.",
  SAFETY_BLOCKED:
    "Không thể tạo ảnh từ ảnh này. Vui lòng chọn một ảnh khác: chính diện, rõ người, đủ sáng.",
  AUTH_FAILED: "Thử đồ tạm thời chưa dùng được. Bạn vẫn có thể chọn sản phẩm và đặt hàng bình thường.",
  TIMEOUT: "Tạo ảnh mất quá nhiều thời gian. Vui lòng thử lại.",
  GENERATION_FAILED: "Chưa tạo được ảnh thử đồ. Vui lòng thử lại.",
};

export const TRY_ON_NETWORK_FAILURE_MESSAGE = "Không kết nối được. Vui lòng kiểm tra mạng và thử lại.";

/** The reason if it is one the server can send, else `null`. */
export function parseTryOnFailureReason(reason: unknown): TryOnFailureReason | null {
  return typeof reason === "string" && reason in FAILURE_COPY ? (reason as TryOnFailureReason) : null;
}

/** A guest who has used its allowance continues by signing in. */
export function isLoginRequired(reason: TryOnFailureReason | null): boolean {
  return reason === "LOGIN_REQUIRED";
}

export type TryOnQuotaUpsell = Readonly<{ title: string; body: string }>;

/**
 * What a guest who hit a limit is offered: a free account has a bigger allowance. Only a guest is
 * ever offered it — a signed-in shopper already has the account's allowance, and a limit that is
 * not about the allowance (busy, bad photo) has nothing to upsell.
 */
export function tryOnQuotaUpsell(
  reason: TryOnFailureReason | null,
  signedIn: boolean,
): TryOnQuotaUpsell | null {
  if (signedIn || (reason !== "RATE_LIMITED" && reason !== "LOGIN_REQUIRED")) return null;
  return {
    title: "Đăng ký tài khoản miễn phí để thử đồ nhiều hơn",
    body: `Khách chưa đăng nhập được ${TRY_ON_GUEST_QUOTA.perDay} lượt mỗi ngày, mỗi lượt cách nhau ${TRY_ON_GUEST_QUOTA.perMinute === 1 ? "1 phút" : `${TRY_ON_GUEST_QUOTA.perMinute} lượt/phút`}. Có tài khoản, bạn được ${TRY_ON_MEMBER_QUOTA.perDay} lượt mỗi ngày và thử liên tiếp ${TRY_ON_MEMBER_QUOTA.perMinute} lượt mỗi phút.`,
  };
}

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
