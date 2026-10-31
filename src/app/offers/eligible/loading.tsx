import { ListingBreadcrumbs, ListingHeader, ListingProductGrid, ListingShell } from "@/components/brand/listing-chrome";

/** A shell in the listing's own chrome and grid while the cart-scoped offer is read on the server. */
export default function EligibleOffersLoading() {
  return (
    <ListingShell>
      <ListingBreadcrumbs
        items={[{ label: "Trang chủ", href: "/" }, { label: "Thanh toán", href: "/checkout" }, { label: "Sản phẩm áp dụng ưu đãi" }]}
      />
      <ListingHeader eyebrow="Ưu đãi" title="Sản phẩm áp dụng ưu đãi">
        <p className="mt-6 max-w-2xl text-sm leading-6 text-[#3B2219]/70" role="status" aria-live="polite">
          Đang tải các sản phẩm áp dụng ưu đãi…
        </p>
      </ListingHeader>
      <div className="mt-8" aria-hidden="true">
        <ListingProductGrid>
          {Array.from({ length: 8 }, (_, index) => (
            <div key={index}>
              <div className="aspect-[2/3] animate-pulse bg-black/5" />
              <div className="mx-auto mt-3 h-4 w-3/4 animate-pulse bg-black/5" />
              <div className="mx-auto mt-2 h-3 w-1/3 animate-pulse bg-black/5" />
            </div>
          ))}
        </ListingProductGrid>
      </div>
    </ListingShell>
  );
}
