import {
  TRY_ON_UPLOAD_JPEG_QUALITY,
  tryOnUploadSize,
} from "./try-on-model.ts";

/**
 * Shrinks the shopper's photo in the browser before it is uploaded, so the request, the server's
 * checks and the model's input are all small. Camera photos are several MB; the model gains nothing
 * from more than about 1200 px on the long side.
 *
 * The photo is drawn upright (EXIF orientation applied), onto white so a transparent PNG does not go
 * black, and re-encoded as JPEG, which also drops its EXIF (location, device) from what is uploaded.
 *
 * Never a gate: if the browser cannot decode or encode the photo, or the result is not smaller, the
 * original is returned unchanged and the server validates it as before.
 */
export async function compressTryOnPhoto(file: File): Promise<File> {
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    try {
      const { width, height } = tryOnUploadSize(bitmap.width, bitmap.height);
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d");
      if (context === null) return file;
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, width, height);
      context.drawImage(bitmap, 0, 0, width, height);
      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, "image/jpeg", TRY_ON_UPLOAD_JPEG_QUALITY),
      );
      if (blob === null || blob.type !== "image/jpeg" || blob.size >= file.size) return file;
      return new File([blob], "photo.jpg", { type: "image/jpeg" });
    } finally {
      bitmap.close();
    }
  } catch {
    return file;
  }
}
