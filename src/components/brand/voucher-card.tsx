import { useId } from "react";

import { voucherExpiryWarning, type VoucherPickerItem } from "@/routes/voucher-picker-model";
import { VoucherIcon } from "./voucher-icons";

/**
 * One voucher of the picker (spec §7.3), drawn as a ticket. It is a toggle button: pressing a chosen voucher again un-chooses it, which is
 * why the picker needs no "do not use a voucher" row. The state is `aria-pressed` (and the ring and the check, never colour alone); a voucher
 * that cannot be used is a disabled button with its reason in text; the whole ticket is a 64px+ touch target. Nothing here knows about money
 * or eligibility -- it renders what the server model says.
 *
 * "Còn N ngày" needs the clock, so the caller passes `nowMs` after mount (null on the server render and the first client render).
 */
export function VoucherCard({ item, onToggle, disabled, nowMs }: Readonly<{
  item: VoucherPickerItem;
  onToggle: () => void;
  disabled: boolean;
  nowMs: number | null;
}>) {
  const descriptionId = useId();
  const unavailable = !item.selectable;
  const expiry = nowMs === null ? null : voucherExpiryWarning(item.endsAtIso, nowMs);
  return (
    <li>
      <button
        type="button"
        className="voucher-ticket"
        aria-pressed={item.selected}
        aria-label={`${item.title}. ${item.name}`}
        aria-describedby={descriptionId}
        disabled={unavailable || disabled}
        onClick={onToggle}
        data-voucher-id={item.id}
      >
        <span className="voucher-ticket__stub" aria-hidden="true">
          <span className="voucher-ticket__val" data-long={item.valueLabel.length > 5 ? "true" : undefined}>{item.valueLabel}</span>
          {item.valueSub ? <span className="voucher-ticket__sub">{item.valueSub}</span> : null}
        </span>
        <span className="voucher-ticket__body">
          <span className="voucher-ticket__main">
            <span aria-hidden="true" className="voucher-ticket__name">{item.name}</span>
            <span id={descriptionId} className="grid gap-px">
              {item.condition ? <span className="voucher-ticket__cond">{item.condition}</span> : null}
              <span className="voucher-ticket__line">
                {unavailable ? (
                  item.disabledReason ? <span className="voucher-ticket__need">{item.disabledReason}</span> : null
                ) : item.savingText ? (
                  <span className="voucher-ticket__save"><span className="sr-only">Dự kiến giảm </span><span aria-hidden="true">{item.savingText}</span></span>
                ) : null}
                {expiry ? <span className="voucher-ticket__warn"><VoucherIcon name="clock" className="h-3 w-3" />{expiry}</span> : null}
                {item.publicCode ? <span className="voucher-ticket__code">Mã {item.publicCode}</span> : null}
              </span>
            </span>
          </span>
          <span className="voucher-ticket__mark" aria-hidden="true"><VoucherIcon name="check" /></span>
        </span>
        {item.progressPercent !== null ? <span aria-hidden="true" className="voucher-ticket__progress"><i style={{ width: `${item.progressPercent}%` }} /></span> : null}
      </button>
    </li>
  );
}
