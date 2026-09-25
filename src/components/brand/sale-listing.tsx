import { ProductCard, type ProductCardTone } from "@/components/brand/product-card";
import {
  ListingEmptyState,
  ListingPagination,
  ListingProductGrid,
  ListingResultCount,
  ListingSubnav,
} from "@/components/brand/listing-chrome";
import { SALE_CHILD_NAVIGATION, SALE_ROOT_NAVIGATION } from "@/brand/sale.config";
import type { FlashSaleViewModel } from "@/routes/flash-sale-model";

/**
 * Markup shared by `/sale`, `/sale/uu-dai` and `/sale/flash-sale`. Which products each lists is the
 * loader's decision (`@/routes/sale`); this only draws the tabs, the count, the grid and the pager.
 */

const tones: readonly ProductCardTone[] = ["stone", "olive", "ink", "sand"];

/** Tất cả / Ưu đãi / Flash Sale, with the current listing marked. */
export function SaleListingSubnav({ currentHref }: Readonly<{ currentHref: string }>) {
  const items = [
    { label: "Tất cả", fullLabel: "Tất cả sản phẩm Sale", href: SALE_ROOT_NAVIGATION.href },
    ...SALE_CHILD_NAVIGATION.map(({ href, label }) => ({ label, href })),
  ].map((item) => ({ ...item, current: item.href === currentHref }));
  return <ListingSubnav label="Danh mục Sale" items={items} />;
}

export function SaleListingBody({
  data,
  countLabel,
  emptyTitle,
  paginationLabel,
}: Readonly<{
  data: FlashSaleViewModel;
  /** Follows the number, e.g. "sản phẩm đang giảm giá". */
  countLabel: string;
  emptyTitle: string;
  paginationLabel: string;
}>) {
  if (data.totalCount === 0) {
    return (
      <ListingEmptyState
        titleId="sale-empty-title"
        eyebrow="Ưu đãi hiện tại"
        title={emptyTitle}
        copy="Sản phẩm sẽ xuất hiện tại đây khi có chương trình khuyến mãi đang hoạt động."
        action={{ href: "/shop", label: "Xem toàn bộ cửa hàng" }}
      />
    );
  }

  return (
    <section aria-labelledby="sale-products-title" className="mt-8">
      <h2 id="sale-products-title" className="sr-only">
        Sản phẩm đang giảm giá
      </h2>
      {/* Live, because the count is what changes when a campaign boundary passes and the shell
          re-reads the route underneath the reader. */}
      <div className="border-b border-[#3B2219]/15 pb-4">
        <ListingResultCount live>
          {data.totalCount} {countLabel}
        </ListingResultCount>
      </div>
      <div className="mt-8">
        <ListingProductGrid>
          {data.cards.map((card, index) => (
            <ProductCard
              key={card.id}
              model={card.model}
              tone={tones[(data.toneOffset + index) % tones.length]!}
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
    </section>
  );
}
