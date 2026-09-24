import Link from "next/link";

import { BRAND } from "@/brand";
import { BrandHistoricalPreorderNotice } from "@/components/brand/historical-preorder-notice";
import { createStorefrontRoute } from "@/routes/factory";
import {
  loadCheckoutSuccessRoute,
  type CheckoutSuccessRouteProps,
} from "@/routes/checkout-success";
import type { CheckoutSuccessViewModel } from "@/routes/checkout-success-model";
import { buildCheckoutSuccessMetadata } from "@/routes/metadata/checkout-success";

/** The order confirmation's markup. The order lookup and its Purchase reporting live in the loader. */

function render(data: CheckoutSuccessViewModel) {
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
            Đặt hàng thành công
          </li>
        </ol>
      </nav>
      <h1 className="mt-4 text-[clamp(3rem,9vw,8rem)] font-semibold leading-[0.9] tracking-[-0.05em]">
        {data.confirmed ? "ĐẶT HÀNG THÀNH CÔNG" : "CHƯA THỂ XÁC NHẬN"}
      </h1>

      <div className="mt-12 max-w-2xl border-t border-black/20 pt-8">
        {data.confirmed && data.orderCode ? (
          <div role="status">
            <p className="font-display text-2xl md:text-3xl">Cảm ơn bạn đã đặt hàng.</p>
            <p className="mt-4 text-sm leading-6 text-black/75">
              Mã đơn <strong className="font-semibold text-black">{data.orderCode}</strong>. {BRAND.identity.name} sẽ liên hệ qua số điện thoại đã cung cấp để xác nhận đơn COD trước khi giao.
            </p>
          </div>
        ) : (
          <div role="alert" data-ui-state="empty">
            <p className="font-display text-2xl md:text-3xl">Không tìm thấy đơn đã xác nhận.</p>
            <p className="mt-4 text-sm leading-6 text-black/75">
              Mã xác nhận không hợp lệ hoặc đơn chưa ở trạng thái hoàn tất. Nếu bạn vừa đặt hàng và chưa chắc trạng thái, vui lòng không gửi lại đơn ngay.
            </p>
          </div>
        )}

        {data.confirmed && data.preorderHistory ? (
          <BrandHistoricalPreorderNotice history={data.preorderHistory} />
        ) : null}

        <div className="mt-8 flex flex-wrap items-center gap-4">
          {data.confirmed ? (
            <Link className="btn btn--primary" href="/track-order">
              Tra cứu đơn hàng
            </Link>
          ) : null}
          <Link className="btn btn--outline" href="/shop">
            Tiếp tục mua sắm
          </Link>
          <Link
            className="inline-block px-4 py-2 text-xs font-semibold uppercase tracking-[0.14em] text-black/75 underline underline-offset-4 hover:text-black focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-black"
            href="/"
          >
            Về trang chủ
          </Link>
        </div>
      </div>
    </div>
  );
}

const route = createStorefrontRoute<CheckoutSuccessRouteProps, CheckoutSuccessViewModel>({
  load: loadCheckoutSuccessRoute,
  render,
});

export const metadata = buildCheckoutSuccessMetadata();
export default route.Page;
