import type { Metadata } from "next";
import { BRAND } from "@/brand";

export const metadata: Metadata = {
  title: "Hàng mới",
  description: `Những sản phẩm mới nhất từ ${BRAND.identity.name}.`,
};

export default function NewArrivalsPage() {
  return (
    <div className="mx-auto min-h-[65vh] max-w-[1600px] px-6 py-16 md:py-24">
      <p className="eyebrow">Drop / 01</p>
      <h1 className="mt-4 max-w-6xl text-[clamp(3.5rem,10vw,9rem)] font-semibold leading-[0.86] tracking-[-0.05em]">
        HÀNG MỚI
      </h1>
      <div className="mt-12 border-t border-black/20 pt-8">
        <p className="max-w-2xl font-serif text-2xl leading-snug md:text-3xl">
          Những phom dáng, chất liệu và lớp trang phục theo mùa mới nhất — được ra mắt với số lượng chọn lọc.
        </p>
      </div>
    </div>
  );
}
