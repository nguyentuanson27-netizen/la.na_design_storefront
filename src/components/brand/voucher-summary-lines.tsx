"use client";

import type { VoucherPickerModel } from "@/routes/voucher-picker-model";
import { useT } from "@/i18n/client";

/**
 * Voucher v1 (UI refresh): the lines a voucher takes off, as rows of a `<dl class="voucher-rows">`: a colour square in the voucher type's colour, the
 * type's name, and the amount in red. The picker lists them inside its bill; the cart lists them above its "Dự kiến sau ưu đãi" total. Everything
 * comes from the server's model; nothing is computed here.
 */
export function VoucherDiscountRows({ summary, part }: Readonly<{ summary: VoucherPickerModel["summary"]; part: "merchandise" | "shipping" }>) {
  const t = useT();
  if (part === "shipping") {
    return summary.shippingDiscountText === null ? null : (
      <div className="voucher-rows__neg voucher-tone voucher-tone--teal">
        <dt className="voucher-rows__label"><i aria-hidden="true" className="voucher-swatch" />{t("Voucher vận chuyển")}</dt>
        <dd>{t(summary.shippingDiscountText)}</dd>
      </div>
    );
  }
  return (
    <>
      {summary.discountLines.map((line) => (
        <div className={`voucher-rows__neg voucher-tone voucher-tone--${line.tone}`} key={line.id}>
          <dt className="voucher-rows__label"><i aria-hidden="true" className="voucher-swatch" />{t(line.label)}</dt>
          <dd>{line.amountText}</dd>
        </div>
      ))}
    </>
  );
}
