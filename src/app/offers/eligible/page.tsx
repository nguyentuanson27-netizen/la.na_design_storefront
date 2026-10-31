import Link from "next/link";

import { PRODUCT_CARD_EAGER_COUNT, ProductCard, type ProductCardTone } from "@/components/brand/product-card";
import {
  ListingBreadcrumbs,
  ListingEmptyState,
  ListingHeader,
  ListingPagination,
  ListingProductGrid,
  ListingResultCount,
  ListingShell,
} from "@/components/brand/listing-chrome";
import { createStorefrontRoute } from "@/routes/factory";
import { loadEligibleOffersRoute, type EligibleOffersRouteProps, type EligibleOffersViewModel } from "@/routes/eligible-offers";
import { buildEligibleOffersMetadata } from "@/routes/metadata/eligible-offers";

/**
 * Markup only, drawn with the listing chrome, cards and paging every storefront listing uses. The route loader applies
 * the trusted-client rate limits and lists the products of the offer the cart is one unit away from.
 */
const tones: readonly ProductCardTone[] = ["stone", "olive", "ink", "sand"];

function render({ offerName, listing, limited, retryHref }: EligibleOffersViewModel) {
  return (
    <ListingShell>
      <ListingBreadcrumbs
        items={[{ label: "Trang chủ", href: "/" }, { label: "Thanh toán", href: "/checkout" }, { label: "Sản phẩm áp dụng ưu đãi" }]}
      />
      <ListingHeader eyebrow="Ưu đãi" title="Sản phẩm áp dụng ưu đãi">
        {offerName ? (
          <p className="mt-6 max-w-2xl text-sm leading-6 text-[#3B2219]/70">
            {offerName}. Những sản phẩm dưới đây thuộc phạm vi ưu đãi. Giá, tồn kho và quyền nhận ưu đãi sẽ được tính lại khi nàng thêm vào giỏ.
          </p>
        ) : null}
      </ListingHeader>

      {listing && listing.totalCount > 0 ? (
        <section aria-labelledby="eligible-offers-products-title" className="mt-8">
          <h2 id="eligible-offers-products-title" className="sr-only">
            Sản phẩm áp dụng ưu đãi
          </h2>
          <div className="border-b border-[#3B2219]/15 pb-4">
            <ListingResultCount>{listing.totalCount} sản phẩm</ListingResultCount>
          </div>
          <div className="mt-8">
            <ListingProductGrid>
              {listing.cards.map((card, index) => (
                <ProductCard
                  key={card.id}
                  model={card.model}
                  tone={tones[(listing.toneOffset + index) % tones.length]!}
                  eager={index < PRODUCT_CARD_EAGER_COUNT}
                />
              ))}
            </ListingProductGrid>
          </div>
          <ListingPagination
            label="Phân trang sản phẩm ưu đãi"
            page={listing.page}
            totalPages={listing.totalPages}
            previousHref={listing.previousHref}
            nextHref={listing.nextHref}
          />
        </section>
      ) : limited ? (
        <ListingEmptyState
          titleId="eligible-offers-limited-title"
          eyebrow="Ưu đãi"
          title="Gợi ý ưu đãi đang có quá nhiều lượt truy cập"
          copy="Nàng thử lại sau ít phút nhé."
          action={{ href: "/shop", label: "Xem tất cả sản phẩm" }}
        />
      ) : retryHref ? (
        // A plain anchor forces a fresh server render; a soft navigation to the same URL may not.
        <section aria-labelledby="eligible-offers-retry-title" className="py-20 text-center" data-ui-state="error">
          <p className="eyebrow text-[#70584B]">Ưu đãi</p>
          <h2 id="eligible-offers-retry-title" className="mx-auto mt-4 max-w-2xl font-display text-2xl font-normal text-[#2A1810] md:text-3xl">
            Gợi ý ưu đãi đang tải chậm hơn bình thường
          </h2>
          <p className="mx-auto mt-3 max-w-xl text-sm leading-6 text-[#3B2219]/70">Nàng thử lại giúp mình nhé.</p>
          <div className="mt-6 flex flex-wrap items-center justify-center gap-4">
            <a href={retryHref} className="btn btn--primary">Thử lại</a>
            <Link href="/shop" className="inline-flex min-h-11 items-center text-sm underline underline-offset-4">Xem tất cả sản phẩm</Link>
          </div>
        </section>
      ) : (
        <ListingEmptyState
          titleId="eligible-offers-empty-title"
          eyebrow="Ưu đãi"
          title="Ưu đãi hoặc giỏ hàng đã thay đổi"
          copy="Hiện không có sản phẩm áp dụng ưu đãi phù hợp với giỏ hàng của nàng."
          action={{ href: "/shop", label: "Xem tất cả sản phẩm" }}
        />
      )}
    </ListingShell>
  );
}

const route = createStorefrontRoute<EligibleOffersRouteProps, EligibleOffersViewModel>({
  load: loadEligibleOffersRoute,
  render,
});

export const metadata = buildEligibleOffersMetadata();
export default route.Page;
