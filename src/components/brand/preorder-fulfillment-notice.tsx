import type { PreorderFulfillmentNotice } from "@/commerce/preorder-fulfillment-presentation";

/**
 * Markup only, for master spec §30's preorder truth in the cart and at checkout.
 *
 * Every number and every zone label is handed in by `buildPreorderFulfillmentNotice()`. This file
 * decides nothing: no day count, no shipping window, no rule about when a shipment is held. That
 * is the point — cart and checkout render the same component from the same projection, so the two
 * pages cannot tell a shopper different things about one basket.
 *
 * The wording states a process and an estimate. It never names a delivery date, because §30 starts
 * the preparation clock at successful system confirmation and nothing here knows when that will be.
 */
export function BrandPreorderFulfillmentNotice({
  notice,
}: Readonly<{ notice: PreorderFulfillmentNotice }>) {
  const preorderLabel = notice.preorderLabel;

  return (
    <section
      aria-labelledby="preorder-fulfillment-title"
      className="preorder-notice mt-6 border border-black/25 px-4 py-4"
      data-preorder-notice="true"
    >
      <h2
        className="text-xs font-semibold uppercase tracking-[0.14em]"
        id="preorder-fulfillment-title"
      >
        {preorderLabel}
      </h2>
      <p className="mt-3 text-sm leading-6 text-black/75">
        Thời gian chuẩn bị: {notice.preparationDays} ngày lịch {notice.preparationBasis}.
      </p>
      {notice.hasMixedReadyLines ? (
        <p className="mt-2 text-sm leading-6 text-black/75" data-preorder-mixed="true">
          Đơn hàng có cả sản phẩm sẵn hàng và sản phẩm {preorderLabel}. Toàn bộ đơn sẽ được giữ lại
          và giao cùng nhau trong một lần sau khi sản phẩm {preorderLabel} sẵn sàng.
        </p>
      ) : null}
      <p className="mt-2 text-sm leading-6 text-black/75">
        Sau thời gian chuẩn bị, thời gian giao hàng dự kiến được tính thêm:
      </p>
      <ul className="mt-2 space-y-1 text-sm leading-6 text-black/75">
        {notice.shippingWindows.map((window) => (
          <li key={window.zoneLabel}>
            {window.zoneLabel}: {window.estimateText}
          </li>
        ))}
      </ul>
      <p className="mt-2 text-xs leading-5 text-black/60">{notice.estimateCaveat}</p>
    </section>
  );
}
