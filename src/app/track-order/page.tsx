import type { Metadata } from "next";
import Link from "next/link";

import { BRAND } from "@/brand";
import { GuestOrderTrackingForm } from "@/components/commerce/guest-order-tracking-form";

export const metadata: Metadata = {
  title: "Tra cứu đơn hàng",
  description: `Tra cứu trạng thái đơn hàng COD của ${BRAND.identity.name} bằng mã đơn và số điện thoại.`,
};

export default function TrackOrderPage() {
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

        <GuestOrderTrackingForm />
      </div>
    </div>
  );
}
