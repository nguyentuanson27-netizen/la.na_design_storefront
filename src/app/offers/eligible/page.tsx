import Link from "@/components/brand/localized-link";

import {
  ListingBreadcrumbs,
  ListingEmptyState,
  ListingHeader,
  ListingShell,
  ListingViewBar,
} from "@/components/brand/listing-chrome";
import { EligibleOffersInfiniteGrid } from "@/components/brand/eligible-offers-infinite-grid";
import { createStorefrontRoute, type RequestI18n } from "@/routes/factory";
import { loadEligibleOffersRoute, type EligibleOffersRouteProps, type EligibleOffersViewModel } from "@/routes/eligible-offers";
import { buildEligibleOffersMetadata } from "@/routes/metadata/eligible-offers";

function render({ campaignId, offerName, listing, limited, retryHref, precedingProductIds }: EligibleOffersViewModel, { t }: RequestI18n) {
  return (
    <ListingShell>
      <ListingBreadcrumbs
        items={[{ label: "Trang chủ", href: "/" }, { label: "Thanh toán", href: "/checkout" }, { label: "Sản phẩm áp dụng ưu đãi" }]}
      />
      <ListingHeader eyebrow={t("Ưu đãi")} title={t("Sản phẩm áp dụng ưu đãi")}>
        {offerName ? (
          <p className="mt-6 max-w-2xl text-sm leading-6 text-[#3B2219]/70">
            {offerName}. {t("Những sản phẩm dưới đây thuộc phạm vi ưu đãi. Giá, tồn kho và quyền nhận ưu đãi sẽ được tính lại khi nàng thêm vào giỏ.")}
          </p>
        ) : null}
      </ListingHeader>

      {listing && listing.totalCount > 0 ? (
        <section aria-labelledby="eligible-offers-products-title" className="mt-8">
          <h2 id="eligible-offers-products-title" className="sr-only">
            {t("Sản phẩm áp dụng ưu đãi")}
          </h2>
          <ListingViewBar totalCount={listing.totalCount} />
          <EligibleOffersInfiniteGrid
            initialCards={listing.cards}
            totalCount={listing.totalCount}
            totalPages={listing.totalPages}
            initialPage={listing.page}
            campaignId={campaignId ?? ""}
            toneOffset={listing.toneOffset}
            nextHref={listing.nextHref}
            precedingProductIds={precedingProductIds}
          />
        </section>
      ) : limited ? (
        <ListingEmptyState
          titleId="eligible-offers-limited-title"
          eyebrow={t("Ưu đãi")}
          title={t("Gợi ý ưu đãi đang có quá nhiều lượt truy cập")}
          copy={t("Nàng thử lại sau ít phút nhé.")}
          action={{ href: "/shop", label: "Xem tất cả sản phẩm" }}
        />
      ) : retryHref ? (
        // A plain anchor forces a fresh server render; a soft navigation to the same URL may not.
        <section aria-labelledby="eligible-offers-retry-title" className="py-20 text-center" data-ui-state="error">
          <p className="eyebrow text-[#70584B]">{t("Ưu đãi")}</p>
          <h2 id="eligible-offers-retry-title" className="mx-auto mt-4 max-w-2xl font-display text-2xl font-normal text-[#2A1810] md:text-3xl">
            {t("Gợi ý ưu đãi đang tải chậm hơn bình thường")}
          </h2>
          <p className="mx-auto mt-3 max-w-xl text-sm leading-6 text-[#3B2219]/70">{t("Nàng thử lại giúp mình nhé.")}</p>
          <div className="mt-6 flex flex-wrap items-center justify-center gap-4">
            <a href={retryHref} className="btn btn--primary">{t("Thử lại")}</a>
            <Link href="/shop" className="inline-flex min-h-11 items-center text-sm underline underline-offset-4">{t("Xem tất cả sản phẩm")}</Link>
          </div>
        </section>
      ) : (
        <ListingEmptyState
          titleId="eligible-offers-empty-title"
          eyebrow={t("Ưu đãi")}
          title={t("Ưu đãi hoặc giỏ hàng đã thay đổi")}
          copy={t("Hiện không có sản phẩm áp dụng ưu đãi phù hợp với giỏ hàng của nàng.")}
          action={{ href: "/shop", label: "Xem tất cả sản phẩm" }}
        />
      )}
    </ListingShell>
  );
}

const route = createStorefrontRoute<EligibleOffersRouteProps, EligibleOffersViewModel>({
  load: loadEligibleOffersRoute,
  // A direct call to the canonical builder: the route contract accepts no other shape here.
  metadata: () => buildEligibleOffersMetadata(),
  render,
});

export const generateMetadata = route.generateMetadata;
export default route.Page;
