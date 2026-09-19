import type { HistoricalPreorderPresentation } from "@/commerce/historical-preorder-presentation";

function formatHistoricalDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("vi-VN", {
    timeZone: "Asia/Ho_Chi_Minh",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(date);
}

function formatWindow(minimumDays: number, maximumDays: number): string {
  return minimumDays === maximumDays
    ? `${minimumDays} ngày`
    : `${minimumDays}–${maximumDays} ngày`;
}

/**
 * F8c — one markup path for immutable historical preorder truth on confirmation and tracking.
 *
 * All dates and numerical shipping windows arrive from the I7 projection. This component formats
 * them but never recalculates readiness, reads live inventory, or imports the current A5 day ranges.
 */
export function BrandHistoricalPreorderNotice({
  history,
}: Readonly<{ history: HistoricalPreorderPresentation }>) {
  return (
    <section
      aria-labelledby="historical-preorder-title"
      className="preorder-notice mt-6 border border-black/25 px-4 py-4"
      data-historical-preorder="true"
    >
      <h2
        className="text-xs font-semibold uppercase tracking-[0.14em]"
        id="historical-preorder-title"
      >
        {history.preorderLabel}
      </h2>
      <p className="mt-3 text-sm leading-6 text-black/75">
        Sản phẩm {history.preorderLabel} dự kiến sẵn sàng vào{" "}
        <time dateTime={history.preorderReadyAt}>
          {formatHistoricalDate(history.preorderReadyAt)}
        </time>
        . Ngày này được lưu tại thời điểm đơn hàng được hệ thống xác nhận thành công.
      </p>

      {history.isMixedReadyAndPreorder ? (
        <p className="mt-2 text-sm leading-6 text-black/75" data-preorder-mixed="true">
          Đơn hàng có cả sản phẩm sẵn hàng và sản phẩm {history.preorderLabel}. Toàn bộ đơn sẽ được
          giữ lại và giao cùng nhau trong một lần sau khi sản phẩm {history.preorderLabel} sẵn sàng.
          Sản phẩm sẵn hàng không được giao trước.
        </p>
      ) : null}

      {history.shippingWindows ? (
        <>
          <p className="mt-2 text-sm leading-6 text-black/75">
            Sau thời điểm sẵn sàng, thời gian giao hàng dự kiến đã được lưu cùng đơn:
          </p>
          <ul className="mt-2 space-y-1 text-sm leading-6 text-black/75">
            {history.shippingWindows.map((window) => (
              <li key={window.zoneLabel}>
                {window.zoneLabel}: {formatWindow(window.minimumDays, window.maximumDays)}
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs leading-5 text-black/60">{history.estimateCaveat}</p>
        </>
      ) : null}
    </section>
  );
}
