import Link from "next/link";

/** A lightweight shell while the cart-scoped quote is rechecked on the server. */
export default function EligibleOffersLoading() {
  return (
    <main className="mx-auto w-full max-w-5xl px-4 py-10 sm:px-6">
      <Link href="/checkout" className="inline-flex min-h-11 items-center text-sm underline underline-offset-4">
        Quay lại thanh toán
      </Link>
      <h1 className="mt-4 font-display text-3xl leading-tight">Sản phẩm áp dụng ưu đãi</h1>
      <p className="mt-3 text-sm leading-6 text-black/70" role="status" aria-live="polite">
        Đang kiểm tra các sản phẩm phù hợp với giỏ hàng…
      </p>
      <ul className="mt-7 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3" aria-hidden="true">
        {Array.from({ length: 3 }, (_, index) => (
          <li key={index} className="min-w-0 border border-black/15 p-4">
            <div className="aspect-[4/5] animate-pulse bg-black/5" />
            <div className="mt-3 h-4 w-3/4 animate-pulse bg-black/5" />
            <div className="mt-3 h-3 w-1/2 animate-pulse bg-black/5" />
          </li>
        ))}
      </ul>
    </main>
  );
}
