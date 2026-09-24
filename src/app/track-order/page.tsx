import { BRAND } from "@/brand";
import { BrandGuestOrderTrackingForm } from "@/components/brand/guest-order-tracking-form";
import { PageBreadcrumbs, PageHeader, PageShell } from "@/components/brand/page-chrome";
import { createStorefrontRoute } from "@/routes/factory";
import {
  loadTrackOrderRoute,
  type TrackOrderRouteProps,
  type TrackOrderViewModel,
} from "@/routes/track-order";
import { buildTrackOrderMetadata } from "@/routes/metadata/track-order";

/** The order-lookup page's markup. The lookup itself is the form's server action. */

// The view model is empty, so the render prop takes nothing: naming an argument it never reads
// would only invite someone to start reading one.
function render() {
  return (
    <PageShell>
      <PageBreadcrumbs items={[{ label: "Trang chủ", href: "/" }, { label: "Tra cứu đơn hàng" }]} />
      <PageHeader eyebrow="Đơn hàng" title="Tra cứu đơn hàng" />

      <div className="mt-8 grid gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(320px,0.65fr)]">
        <div className="max-w-2xl">
          <p className="font-display text-xl md:text-2xl">
            Nhập mã đơn và số điện thoại đã dùng khi đặt hàng.
          </p>
          <p className="mt-4 text-sm leading-6 text-black/75">
            Kết quả chỉ hiển thị trạng thái xử lý cơ bản của đơn COD. {BRAND.identity.name} không hiển thị địa chỉ, ghi chú hoặc thông tin nội bộ của hệ thống bán hàng tại đây.
          </p>
        </div>

        <BrandGuestOrderTrackingForm />
      </div>
    </PageShell>
  );
}

const route = createStorefrontRoute<TrackOrderRouteProps, TrackOrderViewModel>({
  load: loadTrackOrderRoute,
  render,
});

export const metadata = buildTrackOrderMetadata();
export default route.Page;
