"use client";

import { useLocale, useT } from "@/i18n/client";

const dong = new Intl.NumberFormat("vi-VN");

/**
 * Under a total on the English pages, which show dollars: the amount that is actually charged.
 *
 * The English storefront displays a fixed-rate dollar figure for every price, but an order is
 * priced, confirmed and paid in dong. This line says so beside the total, with the exact dong
 * amount (written `VND`, which the dollar conversion leaves alone). Vietnamese pages show dong
 * already, so it renders nothing there.
 */
export function DongNote({ amountVnd, className }: Readonly<{ amountVnd: number | undefined; className?: string }>) {
  const t = useT();
  const locale = useLocale();
  if (locale === "vi" || amountVnd === undefined) return null;
  return (
    <p className={className ?? "mt-3 text-xs leading-5 text-black/65"} data-dong-note="">
      {t("Giá hiển thị bằng USD chỉ để tham khảo. Đơn hàng được tính và thanh toán bằng VND: {amount}.", {
        amount: `${dong.format(amountVnd)} VND`,
      })}
    </p>
  );
}
