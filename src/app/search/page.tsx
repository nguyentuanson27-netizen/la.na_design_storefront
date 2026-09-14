import type { Metadata } from "next";
import { BRAND } from "@/brand";

export const metadata: Metadata = {
  title: "Tìm kiếm",
  description: `Tìm sản phẩm và bộ sưu tập ${BRAND.identity.name}.`,
};

export default function SearchPage() {
  return (
    <div className="mx-auto min-h-[65vh] max-w-[1600px] px-6 py-16 md:py-24">
      <p className="eyebrow">Tìm / Khám phá</p>
      <h1 className="mt-4 text-[clamp(3.5rem,10vw,9rem)] font-semibold leading-[0.86] tracking-[-0.05em]">
        TÌM KIẾM
      </h1>
      <form className="mt-12 flex max-w-4xl border-b border-black" action="/shop" method="get" role="search">
        <label className="sr-only" htmlFor="site-search">Tìm sản phẩm</label>
        <input
          className="min-w-0 flex-1 bg-transparent py-4 text-xl outline-none placeholder:text-black/40 focus-visible:outline-2 focus-visible:outline-offset-4 md:text-3xl"
          id="site-search"
          name="q"
          placeholder="Sơ mi, quần, áo khoác…"
          type="search"
        />
        <button className="px-4 text-xs font-semibold uppercase tracking-[0.14em]" type="submit">
          Tìm kiếm
        </button>
      </form>
    </div>
  );
}
