import type { ReactNode } from "react";

import { TRY_ON_TEEN_DISCLOSURE } from "@/components/headless/try-on-model";
import type { TryOnResult } from "@/components/headless/try-on-session";

/**
 * A finished try-on picture with what must always travel with it: the download, the statement that
 * it is an AI picture for reference only, and for a teen attestation the disclosure as well. Shared
 * by the PDP dialog and the viewer the dock opens on other pages, so neither can show the picture
 * without them.
 */
export function BrandTryOnResult({
  result,
  productName,
  productSlug,
  isTeen,
  secondaryAction,
}: Readonly<{
  result: TryOnResult;
  productName: string;
  productSlug: string;
  isTeen: boolean;
  /** Beside the download: "Tạo lại" in the dialog, "Xem sản phẩm" elsewhere. */
  secondaryAction: ReactNode;
}>) {
  return (
    <>
      {/* eslint-disable-next-line @next/next/no-img-element -- a generated blob; next/image cannot optimise it. */}
      <img
        src={result.url}
        alt={`Ảnh thử đồ do AI tạo cho ${productName}, chỉ mang tính tham khảo`}
        className="mx-auto mt-2 max-h-[22rem] w-auto max-w-full border border-black/15 object-contain"
      />
      <div className="mt-3 grid grid-cols-2 gap-2">
        <a
          href={result.url}
          download={`thu-do-${productSlug}.${result.mimeType === "image/png" ? "png" : "jpg"}`}
          className="btn btn--primary px-4"
        >
          Tải ảnh
        </a>
        {secondaryAction}
      </div>
      <p className="mt-3 text-xs leading-5 text-black/65">
        Ảnh do AI tạo, chỉ mang tính tham khảo — không đảm bảo kích cỡ, độ vừa vặn, chất liệu hay màu
        sắc thật.
      </p>
      {isTeen ? (
        <p className="mt-2 border-l-[3px] border-[#3B2219] pl-3 text-xs leading-5 text-black/75">
          {TRY_ON_TEEN_DISCLOSURE}
        </p>
      ) : null}
    </>
  );
}
