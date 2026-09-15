import Link from "next/link";

import { BRAND } from "@/brand";
import { BrandGuestOrderTrackingForm } from "@/components/brand/guest-order-tracking-form";
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
    <div className="mx-auto min-h-[65vh] max-w-[1600px] px-6 py-16 md:py-24">
      <nav aria-label="Breadcrumb" className="text-xs uppercase tracking-[0.14em] text-black/70">
        <ol className="flex items-center gap-2">
          <li>
            <Link
              className="hover:text-black focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-black"
              href="/"
            >
              Trang chủ
            </Link>
          </li>
          <li aria-hidden="true">/</li>
          <li aria-current="page" className="text-black font-medium">
            Tra cứu đơn hàng
          </li>
        </ol>
      </nav>
      <h1 className="mt-4 text-[clamp(3rem,9vw,8rem)] font-semibold leading-[0.9] tracking-[-0.05em]">
        TRA CỨU ĐƠN HÀNG
      </h1>

      <div className="mt-12 grid gap-10 border-t border-black/20 pt-8 lg:grid-cols-[minmax(0,1fr)_minmax(320px,0.65fr)]">
        <div className="max-w-2xl">
          <p className="font-serif text-2xl md:text-3xl">
            Nhập mã đơn và số điện thoại đã dùng khi đặt hàng.
          </p>
          <p className="mt-4 text-sm leading-6 text-black/75">
            Kết quả chỉ hiển thị trạng thái xử lý cơ bản của đơn COD. {BRAND.identity.name} không hiển thị địa chỉ, ghi chú hoặc thông tin nội bộ của hệ thống bán hàng tại đây.
          </p>
        </div>

        <BrandGuestOrderTrackingForm />
      </div>
    </div>
  );
}

const route = createStorefrontRoute<TrackOrderRouteProps, TrackOrderViewModel>({
  load: loadTrackOrderRoute,
  render,
});

export const metadata = buildTrackOrderMetadata();
export default route.Page;
