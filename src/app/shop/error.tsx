"use client";

import { BRAND } from "@/brand";

export default function ShopError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="mx-auto min-h-[65vh] max-w-[1600px] px-6 py-16 md:py-24">
      <p className="eyebrow">{BRAND.identity.name} / Store</p>
      <section className="mt-8 max-w-3xl border-t border-black/20 pt-10" aria-labelledby="shop-error-title">
        <h1 id="shop-error-title" className="font-display text-4xl leading-tight md:text-6xl">
          Catalog chưa thể tải lúc này.
        </h1>
        <p className="mt-5 max-w-xl text-sm leading-6 text-black/65">
          Vui lòng thử lại. Nếu catalog vừa được đồng bộ, dữ liệu mới sẽ xuất hiện khi kết nối ổn định trở lại.
        </p>
        <button
          className="mt-8 min-h-12 border border-black bg-black px-6 text-sm font-semibold uppercase tracking-[0.12em] text-white transition hover:bg-white hover:text-black focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-black"
          type="button"
          onClick={() => reset()}
        >
          Thử lại
        </button>
      </section>
    </div>
  );
}
