import Link from "next/link";
import Image from "next/image";

import { createStorefrontRoute } from "@/routes/factory";
import { loadEligibleOffersRoute, type EligibleOffersRouteProps, type EligibleOffersViewModel } from "@/routes/eligible-offers";
import { buildEligibleOffersMetadata } from "@/routes/metadata/eligible-offers";

/** Markup only: the route loader applies trusted-client rate limits and verifies cart-scoped offers. */
function render({ offer, limited }: EligibleOffersViewModel) {
  return (
    <main className="mx-auto w-full max-w-5xl px-4 py-10 sm:px-6">
      <Link href="/checkout" className="inline-flex min-h-11 items-center text-sm underline underline-offset-4">
        Quay lại thanh toán
      </Link>
      <h1 className="mt-4 font-display text-3xl leading-tight">Sản phẩm áp dụng ưu đãi</h1>
      {offer ? (
        <>
          <p className="mt-3 text-sm leading-6 text-black/70">
            {offer.offerName}. Những mẫu dưới đây có phiên bản đã được kiểm tra theo giỏ hàng hiện tại.
            Giá, tồn kho và quyền nhận ưu đãi sẽ được tính lại khi nàng thêm vào giỏ.
          </p>
          <ul className="mt-7 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {offer.products.map((product) => (
              <li key={product.slug} className="min-w-0 border border-black/15 p-4">
                <Link href={`/shop/${encodeURIComponent(product.slug)}`} className="block focus-visible:outline-2 focus-visible:outline-offset-2">
                  {product.imageUrl ? (
                    <Image src={product.imageUrl} width={320} height={400} alt="" className="aspect-[4/5] w-full object-cover" />
                  ) : <div className="aspect-[4/5] w-full bg-black/5" aria-hidden="true" />}
                  <h2 className="mt-3 break-words text-base font-semibold">{product.name}</h2>
                  <span className="mt-2 inline-block text-sm underline underline-offset-4">Xem sản phẩm</span>
                </Link>
                <p className="mt-2 break-words text-xs leading-5 text-black/70">Phiên bản phù hợp: {product.options.join(", ")}</p>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <div className="mt-7 border border-black/15 p-5">
          <p className="text-sm leading-6">{limited ? "Gợi ý ưu đãi đang có quá nhiều lượt truy cập. Nàng thử lại sau ít phút nhé." : "Ưu đãi hoặc giỏ hàng đã thay đổi, hiện không có sản phẩm phù hợp được xác nhận."}</p>
          <Link href="/shop" className="mt-3 inline-flex min-h-11 items-center text-sm underline">Xem tất cả sản phẩm</Link>
        </div>
      )}
    </main>
  );
}

const route = createStorefrontRoute<EligibleOffersRouteProps, EligibleOffersViewModel>({
  load: loadEligibleOffersRoute,
  render,
});

export const metadata = buildEligibleOffersMetadata();
export default route.Page;
