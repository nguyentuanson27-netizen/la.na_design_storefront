import { saleListingByKind } from "@/brand/sale.config";
import {
  ListingBreadcrumbs,
  ListingHeader,
  ListingShell,
} from "@/components/brand/listing-chrome";
import { SaleListingBody, SaleListingSubnav } from "@/components/brand/sale-listing";
import { createStorefrontRoute } from "@/routes/factory";
import type { FlashSaleViewModel } from "@/routes/flash-sale-model";
import { buildSaleMetadata, SALE_LISTING_DESCRIPTIONS, SALE_TITLE } from "@/routes/metadata/sale";
import { loadSaleRoute, type SaleRouteProps } from "@/routes/sale";

/** Markup only: `@/routes/sale` narrows the sale read to FLASH_SALE campaigns. */

const KIND = "FLASH_SALE";
const listing = saleListingByKind(KIND);

function render(data: FlashSaleViewModel) {
  return (
    <ListingShell>
      <ListingBreadcrumbs
        items={[
          { label: "Trang chủ", href: "/" },
          { label: SALE_TITLE, href: "/sale" },
          { label: listing.label },
        ]}
      />
      <ListingHeader eyebrow={SALE_TITLE} title={listing.label}>
        <p className="mt-6 max-w-2xl text-sm leading-6 text-[#3B2219]/70">
          {SALE_LISTING_DESCRIPTIONS[KIND]}
        </p>
        <SaleListingSubnav currentHref={listing.href} />
      </ListingHeader>

      <SaleListingBody
        data={data}
        countLabel="sản phẩm đang Flash Sale"
        emptyTitle="Hiện chưa có Flash Sale nào đang diễn ra."
        paginationLabel="Phân trang Flash Sale"
      />
    </ListingShell>
  );
}

const route = createStorefrontRoute<SaleRouteProps, FlashSaleViewModel>({
  load: (props) => loadSaleRoute(props, KIND),
  metadata: (props) => buildSaleMetadata(props, KIND),
  render,
});
export const generateMetadata = route.generateMetadata;
export default route.Page;
