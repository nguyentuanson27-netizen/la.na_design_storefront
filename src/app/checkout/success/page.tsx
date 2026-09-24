import Link from "next/link";

import { BRAND } from "@/brand";
import { BrandHistoricalPreorderNotice } from "@/components/brand/historical-preorder-notice";
import { PageBreadcrumbs, PageHeader, PageShell } from "@/components/brand/page-chrome";
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
    <PageShell>
      <PageBreadcrumbs items={[{ label: "Trang chủ", href: "/" }, { label: "Đặt hàng thành công" }]} />
      <PageHeader
        eyebrow="Đơn hàng"
        title={data.confirmed ? "Đặt hàng thành công" : "Chưa thể xác nhận"}
      />

      <div className="mt-8 max-w-2xl">
        {data.confirmed && data.orderCode ? (
          <div role="status">
            <p className="font-display text-xl md:text-2xl">Cảm ơn bạn đã đặt hàng.</p>
            <p className="mt-4 text-sm leading-6 text-black/75">
              Mã đơn <strong className="font-semibold text-black">{data.orderCode}</strong>. {BRAND.identity.name} sẽ liên hệ qua số điện thoại đã cung cấp để xác nhận đơn COD trước khi giao.
            </p>
          </div>
        ) : (
          <div role="alert" data-ui-state="empty">
            <p className="font-display text-xl md:text-2xl">Không tìm thấy đơn đã xác nhận.</p>
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
    </PageShell>
  );
}

const route = createStorefrontRoute<CheckoutSuccessRouteProps, CheckoutSuccessViewModel>({
  load: loadCheckoutSuccessRoute,
  render,
});

export const metadata = buildCheckoutSuccessMetadata();
export default route.Page;
