import { BRAND } from "@/brand";

export default function ShopLoading() {
  return (
    <div className="mx-auto min-h-[65vh] max-w-[1600px] px-6 py-16 md:py-24" aria-busy="true" aria-live="polite">
      <p className="eyebrow">{BRAND.identity.name} / Cửa hàng</p>
      <p className="mt-4 text-[clamp(3.5rem,10vw,9rem)] font-semibold leading-[0.86] tracking-[-0.05em] text-black/15" aria-hidden="true">
        CỬA HÀNG
      </p>
      <p className="sr-only">Đang tải cửa hàng.</p>

      <div className="mt-12 grid gap-8 border-t border-black/20 pt-8 md:grid-cols-2" aria-hidden="true">
        <div className="h-24 max-w-xl animate-pulse bg-black/5" />
        <div className="h-20 max-w-lg animate-pulse bg-black/5 md:justify-self-end md:w-full" />
      </div>

      <div className="product-grid mt-16" aria-hidden="true">
        {Array.from({ length: 8 }, (_, index) => (
          <div key={index}>
            <div className="product-visual animate-pulse bg-black/5" />
            {/* One bar: the loaded card shows a price and nothing else. */}
            <div className="mt-3 h-3 w-1/2 animate-pulse bg-black/5" />
          </div>
        ))}
      </div>
    </div>
  );
}
