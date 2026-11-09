import { BRAND } from "@/brand";
import { PlpInfiniteGrid } from "@/components/brand/plp-infinite-grid";
import { EMPTY_PLP_FILTERS } from "@/components/headless/plp-filter-model";
import {
  ListingBreadcrumbs,
  ListingEmptyState,
  ListingHeader,
  ListingPreviousLink,
  ListingShell,
  ListingViewBar,
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
        <div id="san-pham" className="collection-products-anchor">
          <span id="products" className="pointer-events-none absolute h-0 w-0" aria-hidden="true" />
          <ListingEmptyState
            titleId="new-arrivals-empty-title"
            eyebrow="Sản phẩm hiện tại"
            title="Chưa có sản phẩm trong danh mục Hàng mới về."
            copy={`Các thiết kế được ${BRAND.identity.name} chọn giới thiệu sẽ xuất hiện tại đây.`}
            action={{ href: "/shop", label: "Xem toàn bộ cửa hàng" }}
          />
        </div>
      ) : (
        <section aria-labelledby="new-arrivals-products-title" className="mt-8">
          <h2 id="new-arrivals-products-title" className="sr-only">
            Sản phẩm được chọn
          </h2>
          <ListingViewBar totalCount={data.totalCount} />
          <ListingPreviousLink href={data.previousHref} />
          <div className="mt-4">
            {/* Infinite scroll with a real "Xem thêm" link to the next page inside it, so a crawler
                and a reader without script still page through the list (§25). */}
            <PlpInfiniteGrid
              initialProducts={data.cards.map((card) => card.model)}
              totalCount={data.totalCount}
              totalPages={data.totalPages}
              initialPage={data.page}
              source={{ kind: "new-arrivals" }}
              clearHref="/new-arrivals"
              activeFilters={EMPTY_PLP_FILTERS}
              hasNext={data.nextHref !== null}
              nextHref={data.nextHref}
              nextCursor={null}
              toneOffset={data.toneOffset}
              emptyStateAnchors={false}
            />
          </div>
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
