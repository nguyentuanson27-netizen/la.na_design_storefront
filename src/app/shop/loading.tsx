import {
  ListingBreadcrumbs,
  ListingHeader,
  ListingProductGrid,
  ListingShell,
} from "@/components/brand/listing-chrome";

/**
 * The shop's loading skeleton.
 *
 * It draws the same chrome the loaded page does -- shell, breadcrumb, header, grid -- so the
 * heading does not move when the products arrive. It used to render the old oversized sans
 * wordmark and its own grid, which meant the one thing a shopper saw first was the design the
 * listing pages no longer use.
 */
export default function ShopLoading() {
  return (
    <div aria-busy="true" aria-live="polite">
      <ListingShell>
        <ListingBreadcrumbs items={[{ label: "Trang chủ", href: "/" }, { label: "Cửa hàng" }]} />
        <ListingHeader eyebrow="Tất cả sản phẩm" title="Cửa hàng">
          <p className="sr-only">Đang tải cửa hàng.</p>
          <div className="mt-6 h-12 max-w-2xl animate-pulse bg-[#3B2219]/5" aria-hidden="true" />
        </ListingHeader>

        <div className="mt-8 h-24 animate-pulse border-b border-[#3B2219]/15 bg-[#3B2219]/5" aria-hidden="true" />

        <div className="mt-8" aria-hidden="true">
          <ListingProductGrid>
            {Array.from({ length: 8 }, (_, index) => (
              <div key={index}>
                <div className="aspect-[3/4] animate-pulse bg-[#3B2219]/5" />
                {/* One bar: the loaded card shows a name and a price and nothing else. */}
                <div className="mt-3 h-3 w-1/2 animate-pulse bg-[#3B2219]/5" />
              </div>
            ))}
          </ListingProductGrid>
        </div>
      </ListingShell>
    </div>
  );
}
