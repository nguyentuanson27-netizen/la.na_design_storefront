import { ProductCard, type ProductCardTone } from "@/components/brand/product-card";
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
import type { FlashSaleViewModel } from "@/routes/flash-sale-model";
import { buildSaleMetadata, SALE_DESCRIPTION, SALE_TITLE } from "@/routes/metadata/sale";
import { loadSaleRoute, type SaleRouteProps } from "@/routes/sale";

/**
 * Markup only. Which products are on sale, the promotion freshness window and the tracking all
 * stay in `@/routes/sale`: this page changed how the listing looks, not what it selects.
 */

const tones: readonly ProductCardTone[] = ["stone", "olive", "ink", "sand"];

function render(data: FlashSaleViewModel) {
  return (
    <ListingShell>
      <ListingBreadcrumbs items={[{ label: "Trang chủ", href: "/" }, { label: SALE_TITLE }]} />
      <ListingHeader eyebrow="Khuyến mãi" title={SALE_TITLE}>
        <p className="mt-3 max-w-2xl text-sm leading-6 text-[#3B2219]/70">{SALE_DESCRIPTION}</p>
      </ListingHeader>

      {data.totalCount === 0 ? (
        <ListingEmptyState
          titleId="sale-empty-title"
          eyebrow="Ưu đãi hiện tại"
          title="Hiện chưa có sản phẩm đang được giảm giá."
          copy="Sản phẩm sẽ xuất hiện tại đây khi có chương trình khuyến mãi đang hoạt động."
          action={{ href: "/shop", label: "Xem toàn bộ cửa hàng" }}
        />
      ) : (
        <section aria-labelledby="sale-products-title" className="mt-5">
          <h2 id="sale-products-title" className="sr-only">
            Sản phẩm đang giảm giá
          </h2>
          {/* Live, because the count is what changes when a campaign boundary passes and the
              shell re-reads the route underneath the reader. */}
          <ListingResultCount live>{data.totalCount} sản phẩm đang giảm giá</ListingResultCount>
          <div className="mt-4">
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
            label="Phân trang Sale"
            page={data.page}
            totalPages={data.totalPages}
            previousHref={data.previousHref}
            nextHref={data.nextHref}
          />
        </section>
      )}
    </ListingShell>
  );
}

const route = createStorefrontRoute<SaleRouteProps, FlashSaleViewModel>({
  load: loadSaleRoute,
  metadata: (props) => buildSaleMetadata(props),
  render,
});
export const generateMetadata = route.generateMetadata;
export default route.Page;
