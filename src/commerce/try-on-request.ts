import { sniffImageMime } from "./try-on-image.ts";
import {
  TRY_ON_ALLOWED_AGE_STATES,
  TRY_ON_ALLOWED_IMAGE_MIME_TYPES,
  TRY_ON_MAX_IMAGE_BYTES,
  parseTryOnAgeState,
  type TryOnAgeState,
  type TryOnFailureReason,
  type TryOnImageMimeType,
} from "./try-on-policy.ts";

/**
 * Server-side validation of one try-on submission (spec §6, §9, §10).
 *
 * The client's own checks are convenience. This is the enforcement, and it runs before the product
 * is resolved, before the product image is fetched and long before Vertex AI is contacted.
 *
 * The parsed request has exactly three fields. Anything else on the form — a product image URL in
 * particular — is not read, so a forged value has no way to influence what is fetched or sent.
 */

const MAX_PRODUCT_SLUG_LENGTH = 200;

export type ParsedTryOnRequest = Readonly<{
  productSlug: string;
  ageState: TryOnAgeState;
  photo: Readonly<{ bytes: Uint8Array; mimeType: TryOnImageMimeType }>;
}>;

export type TryOnRequestParseResult =
  | Readonly<{ ok: true; value: ParsedTryOnRequest }>
  | Readonly<{
      ok: false;
      reason: Extract<
        TryOnFailureReason,
        | "INVALID_REQUEST"
        | "LIKENESS_REQUIRED"
        | "AGE_STATE_INVALID"
        | "AGE_BLOCKED"
        | "UNSUPPORTED_IMAGE"
        | "IMAGE_TOO_LARGE"
      >;
    }>;

function fail<R extends Extract<TryOnRequestParseResult, { ok: false }>["reason"]>(reason: R) {
  return { ok: false, reason } as const;
}

function isAllowedMime(type: string): type is TryOnImageMimeType {
  return (TRY_ON_ALLOWED_IMAGE_MIME_TYPES as readonly string[]).includes(type);
}

export async function parseTryOnRequest(formData: FormData): Promise<TryOnRequestParseResult> {
  // Gates first: they are cheap, they do not need the photo, and a shopper who fails one should
  // not cost the server a 7 MB read.
  if (formData.get("likenessAcknowledged") !== "true") return fail("LIKENESS_REQUIRED");

  const ageState = parseTryOnAgeState(formData.get("ageState"));
  if (ageState === null) return fail("AGE_STATE_INVALID");
  if (!TRY_ON_ALLOWED_AGE_STATES.includes(ageState)) return fail("AGE_BLOCKED");

  const productSlug = formData.get("productSlug");
  if (
    typeof productSlug !== "string" ||
    productSlug.length === 0 ||
    productSlug.length > MAX_PRODUCT_SLUG_LENGTH
  ) {
    return fail("INVALID_REQUEST");
  }

  const photos = formData.getAll("photo");
  const photo = photos[0];
  if (photos.length !== 1 || typeof photo === "string" || photo === undefined) {
    return fail("UNSUPPORTED_IMAGE");
  }
  if (photo.size > TRY_ON_MAX_IMAGE_BYTES) return fail("IMAGE_TOO_LARGE");
  if (photo.size === 0 || !isAllowedMime(photo.type)) return fail("UNSUPPORTED_IMAGE");

  const bytes = new Uint8Array(await photo.arrayBuffer());
  // The declared type must agree with the bytes: a renamed WebP or GIF is not a JPEG.
  if (sniffImageMime(bytes) !== photo.type) return fail("UNSUPPORTED_IMAGE");

  return { ok: true, value: { productSlug, ageState, photo: { bytes, mimeType: photo.type } } };
}
