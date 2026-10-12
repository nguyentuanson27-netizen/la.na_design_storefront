import { BRAND } from "@/brand";
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
import {
  loadNewArrivalsRoute,
  type NewArrivalsRouteProps,
  type NewArrivalsViewModel,
} from "@/routes/new-arrivals";
import { buildNewArrivalsMetadata } from "@/routes/metadata/new-arrivals";

/** Markup only. The manual selection, its paging, the tracking and the refresh window live in
 *  `@/routes/new-arrivals`. */

const tones: readonly ProductCardTone[] = ["stone", "olive", "ink", "sand"];

function render(data: NewArrivalsViewModel) {
  return (
    <ListingShell>
      <ListingBreadcrumbs
        items={[{ label: "Trang chủ", href: "/" }, { label: "Hàng mới về" }]}
      />
      <ListingHeader eyebrow="Tuyển chọn" title="Hàng mới về">
        <p className="mt-6 max-w-2xl text-sm leading-6 text-[#3B2219]/70">
          {`Những thiết kế được ${BRAND.identity.name} chọn giới thiệu trong danh mục Hàng mới về.`}
        </p>
      </ListingHeader>

      {data.totalCount === 0 ? (
        <ListingEmptyState
          titleId="new-arrivals-empty-title"
          eyebrow="Sản phẩm hiện tại"
          title="Chưa có sản phẩm trong danh mục Hàng mới về."
          copy={`Các thiết kế được ${BRAND.identity.name} chọn giới thiệu sẽ xuất hiện tại đây.`}
          action={{ href: "/shop", label: "Xem toàn bộ cửa hàng" }}
        />
      ) : (
        <section aria-labelledby="new-arrivals-products-title" className="mt-8">
          <h2 id="new-arrivals-products-title" className="sr-only">
            Sản phẩm được chọn
          </h2>
          <div className="border-b border-[#3B2219]/15 pb-4">
            <ListingResultCount>{data.totalCount} sản phẩm</ListingResultCount>
          </div>
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
            label="Phân trang hàng mới về"
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

const route = createStorefrontRoute<NewArrivalsRouteProps, NewArrivalsViewModel>({
  load: loadNewArrivalsRoute,
  metadata: (props) => buildNewArrivalsMetadata(props),
  render,
});

export const generateMetadata = route.generateMetadata;
export default route.Page;
