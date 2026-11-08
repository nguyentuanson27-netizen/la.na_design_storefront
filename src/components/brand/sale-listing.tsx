"use client";

import { PRODUCT_CARD_EAGER_COUNT, ProductCard, type ProductCardTone } from "@/components/brand/product-card";
import {
  ListingEmptyState,
  ListingPagination,
  ListingProductGrid,
  ListingSubnav,
} from "@/components/brand/listing-chrome";
import { PlpFilterPanel } from "@/components/brand/plp-filter-panel";
import { SALE_CHILD_NAVIGATION, SALE_ROOT_NAVIGATION } from "@/brand/sale.config";
import type { FlashSaleViewModel } from "@/routes/flash-sale-model";
import { useT } from "@/i18n/client";

/**
 * Markup shared by `/sale`, `/sale/uu-dai`, `/sale/flash-sale` and `/sale/xa-hang-le-size`. Which
 * products each lists is the loader's decision (`@/routes/sale`); this only draws the tabs, the
 * filter bar, the grid and the pager. The filter bar is the category listing's, so a shopper meets
 * the same size, price and sort controls on every listing.
 */

const tones: readonly ProductCardTone[] = ["stone", "olive", "ink", "sand"];

/** Tất cả, then every sale sub-listing, with the current one marked. */
export function SaleListingSubnav({ currentHref }: Readonly<{ currentHref: string }>) {
  const t = useT();
  const items = [
    { label: "Tất cả", fullLabel: "Tất cả sản phẩm Sale", href: SALE_ROOT_NAVIGATION.href },
    ...SALE_CHILD_NAVIGATION.map(({ href, label }) => ({ label, href })),
  ].map((item) => ({ ...item, current: item.href === currentHref }));
  return <ListingSubnav label={t("Danh mục Sale")} items={items} />;
}

export function SaleListingBody({
  data,
  countLabel,
  emptyTitle,
  paginationLabel,
}: Readonly<{
  data: FlashSaleViewModel;
  /** Follows the number in the bar's hidden live count, e.g. "sản phẩm đang giảm giá". */
  countLabel: string;
  emptyTitle: string;
  paginationLabel: string;
}>) {
  const t = useT();
  const { filters } = data;

  // Nothing is on sale at all: there is nothing to filter, so the bar is not drawn either.
  if (data.totalCount === 0 && !filters?.filtered) {
    return (
      <div id="san-pham" className="collection-products-anchor">
        <span id="products" className="pointer-events-none absolute h-0 w-0" aria-hidden="true" />
        <ListingEmptyState
          titleId="sale-empty-title"
          eyebrow={t("Ưu đãi hiện tại")}
          title={emptyTitle}
          copy={t("Sản phẩm sẽ xuất hiện tại đây khi có chương trình khuyến mãi đang hoạt động.")}
          action={{ href: "/shop", label: "Xem toàn bộ cửa hàng" }}
        />
      </div>
    );
  }

  return (
    <section aria-labelledby="sale-products-title" className="mt-8">
      <h2 id="sale-products-title" className="sr-only">
        {t("Sản phẩm đang giảm giá")}
      </h2>
      {/* Everything on a sale listing is in stock and on sale by construction, so the bar leaves
          out "Còn hàng" and "Sale". Its hidden count is live, because the count is what changes
          when a campaign boundary passes and the shell re-reads the route underneath the reader. */}
      {filters ? (
        <div id="bo-loc" className="collection-products-anchor">
          <PlpFilterPanel
            categoryPath={filters.basePath}
            totalCount={data.totalCount}
            availableSizes={filters.availableSizes}
            saleAvailable={false}
            offerAvailability={false}
            countLabel={countLabel}
            activeFilters={filters.active}
          />
        </div>
      ) : null}
      {data.totalCount === 0 ? (
        <div id="san-pham" className="collection-products-anchor mt-8">
          <span id="products" className="pointer-events-none absolute h-0 w-0" aria-hidden="true" />
          <ListingEmptyState
            titleId="sale-empty-title"
            eyebrow={t("Không tìm thấy")}
            title={t("Không có sản phẩm phù hợp.")}
            copy={t("Thử bỏ bớt bộ lọc hoặc xem lại tất cả sản phẩm đang giảm giá.")}
            action={filters ? { href: filters.basePath, label: "Xóa bộ lọc" } : undefined}
          />
        </div>
      ) : (
        <>
          <div className="mt-8">
            <ListingProductGrid>
              {data.cards.map((card, index) => (
                <ProductCard
                  key={card.id}
                  model={card.model}
                  tone={tones[(data.toneOffset + index) % tones.length]!}
                  eager={index < PRODUCT_CARD_EAGER_COUNT}
                />
              ))}
            </ListingProductGrid>
          </div>
          <ListingPagination
            label={paginationLabel}
            page={data.page}
            totalPages={data.totalPages}
            previousHref={data.previousHref}
            nextHref={data.nextHref}
          />
        </>
      )}
    </section>
  );
}
