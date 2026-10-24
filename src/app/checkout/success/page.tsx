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
            <p className="font-display text-xl md:text-2xl">Cảm ơn nàng đã đặt hàng.</p>
            <p className="mt-4 text-sm leading-6 text-black/75">
              Mã đơn{" "}
              <strong className="whitespace-nowrap text-lg font-semibold tracking-[0.08em] text-black">
                {data.orderCode}
              </strong>
              .{" "}
              {data.paymentMethod === "BANK_TRANSFER"
                ? `${BRAND.identity.name} sẽ xác nhận đơn và giao hàng sau khi nhận được tiền chuyển khoản.`
                : `${BRAND.identity.name} sẽ liên hệ qua số điện thoại đã cung cấp để xác nhận đơn COD trước khi giao.`}
            </p>
            {data.bankTransfer ? (
              <section className="mt-6 border border-black/20 p-5" aria-labelledby="bank-transfer-title" data-bank-transfer>
                <h2 id="bank-transfer-title" className="font-display text-lg">Thông tin chuyển khoản</h2>
                <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
                  <dt className="text-black/60">Ngân hàng</dt>
                  <dd className="font-semibold">{data.bankTransfer.bankName}</dd>
                  <dt className="text-black/60">Số tài khoản</dt>
                  <dd className="font-semibold tracking-[0.06em]">{data.bankTransfer.accountNumber}</dd>
                  <dt className="text-black/60">Chủ tài khoản</dt>
                  <dd className="font-semibold">{data.bankTransfer.accountHolder}</dd>
                  <dt className="text-black/60">Số tiền</dt>
                  <dd className="font-semibold">{data.bankTransfer.amountText}</dd>
                  <dt className="text-black/60">Nội dung</dt>
                  <dd className="font-semibold tracking-[0.06em]">{data.bankTransfer.content}</dd>
                </dl>
                {data.bankTransfer.qr ? (
                  <figure className="mt-4">
                    <svg
                      role="img"
                      aria-label="Mã QR chuyển khoản"
                      viewBox={`-4 -4 ${data.bankTransfer.qr.size + 8} ${data.bankTransfer.qr.size + 8}`}
                      className="h-48 w-48 bg-white"
                      shapeRendering="crispEdges"
                    >
                      <path d={data.bankTransfer.qr.path} fill="#000" />
                    </svg>
                    <figcaption className="mt-2 text-xs text-black/60">Quét bằng ứng dụng ngân hàng để điền sẵn số tiền và nội dung.</figcaption>
                  </figure>
                ) : null}
                <p className="mt-3 text-sm leading-6 text-black/75">
                  Nàng chuyển đúng số tiền và nhập đúng nội dung trên để shop đối chiếu đơn nhanh nhất.
                </p>
              </section>
            ) : data.paymentMethod === "BANK_TRANSFER" ? (
              <p className="mt-6 border border-black/20 p-5 text-sm leading-6" data-bank-transfer-unavailable>
                Đây là đơn chuyển khoản. {BRAND.identity.name} sẽ liên hệ qua số điện thoại đã cung cấp để gửi thông tin chuyển khoản cho nàng.
              </p>
            ) : null}
            <p className="mt-2 text-sm leading-6 text-black/75">
              Nàng có thể tra cứu đơn bất cứ lúc nào bằng mã đơn này và số điện thoại đặt hàng.
            </p>
          </div>
        ) : (
          <div role="alert" data-ui-state="empty">
            <p className="font-display text-xl md:text-2xl">Không tìm thấy đơn đã xác nhận.</p>
            <p className="mt-4 text-sm leading-6 text-black/75">
              Mã xác nhận không hợp lệ hoặc đơn chưa ở trạng thái hoàn tất. Nếu nàng vừa đặt hàng và chưa chắc trạng thái, nàng đừng gửi lại đơn ngay nhé.
            </p>
          </div>
        )}

        {data.confirmed && data.preorderHistory ? (
          <BrandHistoricalPreorderNotice history={data.preorderHistory} />
        ) : null}

        <div className="mt-8 flex flex-wrap items-center gap-4">
          {data.confirmed ? (
            <Link
              className="btn btn--primary"
              href={
                data.orderCode
                  ? `/track-order?order=${encodeURIComponent(data.orderCode)}`
                  : "/track-order"
              }
            >
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
