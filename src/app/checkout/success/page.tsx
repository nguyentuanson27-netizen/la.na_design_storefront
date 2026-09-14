import type { Metadata } from "next";
import Link from "next/link";

import { BRAND } from "@/brand";
import { readCanonicalPurchaseSnapshotSafely } from "@/commerce/canonical-purchase-snapshot";
import { buildMetaPurchasePixelParameters } from "@/commerce/meta-pixel-parameters";
import { readMetaPurchaseSnapshot } from "@/commerce/meta-purchase-snapshot";
import { CommerceEventReporter } from "@/components/analytics/commerce-event-reporter";
import { FacebookPixelEvent } from "@/components/analytics/facebook-pixel-event";
import { prisma } from "@/db/prisma";

export const metadata: Metadata = {
  title: "Đặt hàng thành công",
  description: `Xác nhận đơn hàng COD của ${BRAND.identity.name}.`,
};

const MAX_PUBLIC_CODE_LENGTH = 128;

function parseOrderCode(value: string | string[] | undefined): string | null {
  if (typeof value !== "string") return null;
  if (value.length === 0 || value.length > MAX_PUBLIC_CODE_LENGTH) return null;
  if (value.trim() !== value) return null;
  return value;
}

export default async function CheckoutSuccessPage({
  searchParams,
}: {
  searchParams: Promise<{ order?: string | string[] }>;
}) {
  const orderCode = parseOrderCode((await searchParams).order);
  const order = orderCode
    ? await prisma.orderMirror.findUnique({
        where: { publicCode: orderCode },
        select: { state: true },
      })
    : null;
  const confirmed = order?.state === "CONFIRMED";

  // Vendor-neutral canonical Purchase snapshot from immutable finalized order facts (T7)
  const canonicalPurchase = confirmed && orderCode
    ? await readCanonicalPurchaseSnapshotSafely(prisma, orderCode)
    : null;

  // The Conversions API reports this same sale from the server action that placed it. Both carry
  // the order code as the event id, so Meta collapses them into a single Purchase.
  let purchase = null;
  if (confirmed && orderCode) {
    try {
      purchase = await readMetaPurchaseSnapshot(prisma, orderCode);
    } catch {
      // Tracking failures must never affect checkout success.
    }
  }

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
        {confirmed ? "ĐẶT HÀNG THÀNH CÔNG" : "CHƯA THỂ XÁC NHẬN"}
      </h1>
      <CommerceEventReporter event={canonicalPurchase ? canonicalPurchase.event : null} />
      {purchase && orderCode ? (
        <FacebookPixelEvent
          name="Purchase"
          eventId={orderCode}
          once
          parameters={buildMetaPurchasePixelParameters(purchase)}
        />
      ) : null}

      <div className="mt-12 max-w-2xl border-t border-black/20 pt-8">
        {confirmed && orderCode ? (
          <div role="status">
            <p className="font-serif text-2xl md:text-3xl">Cảm ơn bạn đã đặt hàng.</p>
            <p className="mt-4 text-sm leading-6 text-black/75">
              Mã đơn <strong className="font-semibold text-black">{orderCode}</strong>. {BRAND.identity.name} sẽ liên hệ qua số điện thoại đã cung cấp để xác nhận đơn COD trước khi giao.
            </p>
          </div>
        ) : (
          <div role="alert" data-ui-state="empty">
            <p className="font-serif text-2xl md:text-3xl">Không tìm thấy đơn đã xác nhận.</p>
            <p className="mt-4 text-sm leading-6 text-black/75">
              Mã xác nhận không hợp lệ hoặc đơn chưa ở trạng thái hoàn tất. Nếu bạn vừa đặt hàng và chưa chắc trạng thái, vui lòng không gửi lại đơn ngay.
            </p>
          </div>
        )}

        <div className="mt-8 flex flex-wrap items-center gap-4">
          {confirmed ? (
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
