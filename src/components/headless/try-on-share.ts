/**
 * Sending a finished try-on picture somewhere else: the phone's own share sheet, which is how a
 * shopper asks a friend over Zalo or Messenger "does this suit me?", and on iOS also the easy way
 * into the photo library (a plain download link there only opens a preview).
 *
 * Pure browser capability: the picture is the blob URL already in memory, wrapped as a file for the
 * share call; nothing is uploaded by this site. Where the browser cannot share files (most desktops)
 * `canShareTryOnFiles()` is false and no button is offered.
 */

const RESULT_EXTENSION: Readonly<Record<string, string>> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

export function tryOnResultFileName(productSlug: string, mimeType: string): string {
  return `thu-do-${productSlug}.${RESULT_EXTENSION[mimeType] ?? "jpg"}`;
}

/** Whether this browser can hand image files to its share sheet. */
export function canShareTryOnFiles(): boolean {
  try {
    if (typeof navigator === "undefined" || typeof navigator.share !== "function") return false;
    if (typeof navigator.canShare !== "function") return false;
    const probe = new File([new Blob(["x"], { type: "image/jpeg" })], "probe.jpg", { type: "image/jpeg" });
    return navigator.canShare({ files: [probe] });
  } catch {
    return false;
  }
}

export type TryOnShareOutcome = "shared" | "cancelled" | "failed";

export async function shareTryOnImage(
  input: Readonly<{
    blob: Blob;
    mimeType: string;
    productSlug: string;
    productName: string;
    /** The message that goes with the picture, in the shopper's language; given the link to the product. */
    message?: (link: string) => string;
  }>,
): Promise<TryOnShareOutcome> {
  try {
    // The bytes already in memory, not a `fetch` of the blob URL: the CSP does not allow that.
    const file = new File([input.blob], tryOnResultFileName(input.productSlug, input.mimeType), {
      type: input.mimeType,
    });
    const link = `${window.location.origin}/shop/${encodeURIComponent(input.productSlug)}`;
    await navigator.share({
      files: [file],
      title: input.productName,
      text: input.message?.(link) ?? `Mình thử ${input.productName} bằng AI, bạn xem giúp mình nhé: ${link}`,
    });
    return "shared";
  } catch (error) {
    // Closing the share sheet is a choice, not a fault.
    return error instanceof DOMException && error.name === "AbortError" ? "cancelled" : "failed";
  }
}
