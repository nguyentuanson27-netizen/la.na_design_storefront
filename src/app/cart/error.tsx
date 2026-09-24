"use client";

export default function CartError({ reset }: { reset: () => void }) {
  return (
    <div className="mx-auto min-h-[65vh] max-w-[1600px] px-6 py-16 md:py-24">
      <p className="eyebrow">Mua sắm / Giỏ hàng</p>
      <h1 className="mt-4 text-[clamp(3.5rem,10vw,9rem)] font-semibold leading-[0.86] tracking-[-0.05em]">
        GIỎ HÀNG
      </h1>
      <div className="mt-12 border-t border-black/20 pt-8">
        <p className="font-display text-2xl md:text-3xl">Không thể tải giỏ hàng lúc này.</p>
        <button
          className="mt-6 min-h-11 border border-black bg-black px-5 text-xs font-semibold uppercase tracking-[0.12em] text-white transition hover:bg-white hover:text-black focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-black"
          type="button"
          onClick={reset}
        >
          Thử lại
        </button>
      </div>
    </div>
  );
}
