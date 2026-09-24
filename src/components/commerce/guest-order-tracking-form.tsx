"use client";

import { useActionState } from "react";

import { lookupGuestOrderAction } from "@/commerce/guest-order-tracking-actions";
import { BrandHistoricalPreorderNotice } from "@/components/brand/historical-preorder-notice";
import type {
  GuestOrderPublicStatus,
} from "@/commerce/guest-order-tracking";

const fieldClassName =
  "mt-2 w-full border border-black/25 bg-transparent px-4 py-3 text-base outline-none transition focus:border-black focus:ring-2 focus:ring-black/10";

const statusLabels: Record<GuestOrderPublicStatus, string> = {
  PROCESSING: "Đang xử lý",
  CONFIRMED: "Đã tiếp nhận",
  CHECKING: "Đang xác minh",
  REJECTED: "Không thể hoàn tất",
};

function formatVnd(value: string): string {
  try {
    return `${new Intl.NumberFormat("vi-VN").format(BigInt(value))} ₫`;
  } catch {
    return "—";
  }
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("vi-VN", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

export function GuestOrderTrackingForm() {
  const [state, action, isPending] = useActionState(lookupGuestOrderAction, null);

  return (
    <div className="space-y-8">
      <form action={action} className="space-y-6">
        <div>
          <label className="block text-sm font-semibold" htmlFor="tracking-order-code">
            Mã đơn hàng
          </label>
          <input
            id="tracking-order-code"
            name="orderCode"
            type="text"
            required
            maxLength={128}
            autoComplete="off"
            className={fieldClassName}
          />
        </div>

        <div>
          <label className="block text-sm font-semibold" htmlFor="tracking-phone">
            Số điện thoại
          </label>
          <input
            id="tracking-phone"
            name="phone"
            type="tel"
            required
            maxLength={64}
            autoComplete="tel"
            className={fieldClassName}
          />
        </div>

        <button
          type="submit"
          disabled={isPending}
          className="btn btn--primary"
        >
          {isPending ? "Đang tra cứu…" : "Tra cứu đơn hàng"}
        </button>
      </form>

      {state?.ok ? (
        <section
          className="border-t border-black/20 pt-6"
          role="status"
          aria-live="polite"
          data-ui-state="success"
        >
          <p className="eyebrow">Trạng thái đơn hàng</p>
          <p className="mt-3 font-display text-3xl">{statusLabels[state.order.status]}</p>
          <dl className="mt-6 grid gap-4 text-sm sm:grid-cols-3">
            <div>
              <dt className="text-black/75">Mã đơn</dt>
              <dd className="mt-1 font-semibold break-all">{state.order.orderCode}</dd>
            </div>
            <div>
              <dt className="text-black/75">Thời điểm tạo</dt>
              <dd className="mt-1 font-semibold">{formatDate(state.order.createdAt)}</dd>
            </div>
            <div>
              <dt className="text-black/75">Tổng tiền</dt>
              <dd className="mt-1 font-semibold">{formatVnd(state.order.totalVnd)}</dd>
            </div>
          </dl>
          {state.order.preorderHistory ? (
            <BrandHistoricalPreorderNotice history={state.order.preorderHistory} />
          ) : null}
          {state.order.status === "CHECKING" ? (
            <p className="mt-5 text-sm leading-6 text-black/75">
              Hệ thống đang kiểm tra lại kết quả đồng bộ. Vui lòng không gửi lại đơn chỉ vì trạng thái này.
            </p>
          ) : null}
        </section>
      ) : state ? (
        <div
          className="border border-black/25 p-4 text-sm leading-6"
          role="alert"
          data-ui-state="empty"
        >
          {state.reason === "NOT_FOUND"
            ? "Không tìm thấy đơn hàng khớp với thông tin đã nhập."
            : "Chưa thể tra cứu lúc này. Vui lòng thử lại sau."}
        </div>
      ) : null}
    </div>
  );
}
