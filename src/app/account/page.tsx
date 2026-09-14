import type { Metadata } from "next";

import { BRAND } from "@/brand";
import { AccountAuthPanel } from "@/components/account/account-auth-panel";

export const metadata: Metadata = {
  title: "Tài khoản",
  description: `Đăng nhập hoặc tạo tài khoản ${BRAND.identity.name} để theo dõi đơn hàng thuận tiện hơn.`,
};

export default function AccountPage() {
  return (
    <div className="mx-auto min-h-[65vh] max-w-[1600px] px-6 py-16 md:py-24">
      <p className="eyebrow">Khách hàng / Tài khoản</p>
      <h1 className="mt-4 text-[clamp(3.5rem,10vw,9rem)] font-semibold leading-[0.86] tracking-[-0.05em]">
        TÀI KHOẢN
      </h1>
      <div className="mt-12 grid gap-8 pb-12 md:grid-cols-2 md:pb-16">
        <p className="max-w-xl font-serif text-2xl leading-snug md:text-3xl">
          Lưu thông tin cho lần mua sau và theo dõi lịch sử đơn hàng tại một nơi.
        </p>
        <p className="max-w-lg text-sm leading-6 text-black/70 md:justify-self-end">
          Đăng ký không bắt buộc. Guest checkout và thanh toán COD vẫn hoạt động độc lập với tài khoản.
        </p>
      </div>

      <AccountAuthPanel />
    </div>
  );
}
