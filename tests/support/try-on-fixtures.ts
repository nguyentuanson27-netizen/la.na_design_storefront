/** Tiny valid-signature image fixtures for the try-on tests. Not real photographs. */

export const JPEG_BYTES = new Uint8Array([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0xff, 0xd9,
]);

export const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);

export const WEBP_BYTES = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20,
]);

export function tryOnForm(
  overrides: Readonly<{
    photo?: Blob | null | readonly Blob[];
    likenessAcknowledged?: string | null;
    ageState?: string | null;
    productSlug?: string | null;
    extra?: Readonly<Record<string, string>>;
  }> = {},
): FormData {
  const form = new FormData();
  const photo =
    overrides.photo === undefined
      ? new File([JPEG_BYTES], "me.jpg", { type: "image/jpeg" })
      : overrides.photo;
  if (Array.isArray(photo)) {
    for (const item of photo) form.append("photo", item, "me.jpg");
  } else if (photo !== null) {
    form.append("photo", photo as Blob, "me.jpg");
  }
  const likeness =
    overrides.likenessAcknowledged === undefined ? "true" : overrides.likenessAcknowledged;
  if (likeness !== null) form.append("likenessAcknowledged", likeness);
  const age = overrides.ageState === undefined ? "adult" : overrides.ageState;
  if (age !== null) form.append("ageState", age);
  const slug = overrides.productSlug === undefined ? "vay-hoa" : overrides.productSlug;
  if (slug !== null) form.append("productSlug", slug);
  for (const [key, value] of Object.entries(overrides.extra ?? {})) form.append(key, value);
  return form;
}
