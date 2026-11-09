import {
  ListingBreadcrumbs,
  ListingHeader,
  ListingShell,
} from "@/components/brand/listing-chrome";
import { SaleListingBody, SaleListingSubnav } from "@/components/brand/sale-listing";
import { createStorefrontRoute, type RequestI18n } from "@/routes/factory";
import type { FlashSaleViewModel } from "@/routes/flash-sale-model";
import { buildSaleMetadata, SALE_DESCRIPTION, SALE_TITLE } from "@/routes/metadata/sale";
import { loadSaleRoute, type SaleRouteProps } from "@/routes/sale";

/**
 * Markup only. Which products are on sale, the promotion freshness window and the tracking all
 * stay in `@/routes/sale`: this page changed how the listing looks, not what it selects.
 */

function render(data: FlashSaleViewModel, { t }: RequestI18n) {
  return (
    <ListingShell>
      <ListingBreadcrumbs items={[{ label: "Trang chủ", href: "/" }, { label: SALE_TITLE }]} />
      <ListingHeader eyebrow={t("Khuyến mãi")} title={t(SALE_TITLE)}>
        <p className="mt-6 max-w-2xl text-sm leading-6 text-[#3B2219]/70">{t(SALE_DESCRIPTION)}</p>
        <SaleListingSubnav currentHref="/sale" />
      </ListingHeader>

      <SaleListingBody
        data={data}
        countLabel="sản phẩm đang giảm giá"
        emptyTitle="Hiện chưa có sản phẩm đang được giảm giá."
      />
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
