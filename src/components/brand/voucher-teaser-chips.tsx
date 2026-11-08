"use client";

import { useId, useState } from "react";

import type { VoucherTeaserItem } from "@/commerce/voucher-teaser";
import { VoucherIcon } from "./voucher-icons";

/**
 * Voucher v1 (V17, UI refresh): the PDP teaser as small tickets in one swipeable row. Each shows two short lines ("Giảm 200K" over
 * "Đơn từ 1,5 triệu"); pressing one opens its full sentence below. It states a voucher's own conditions only and promises nothing: whether a
 * cart qualifies is decided in the cart.
 *
 * Screen readers get the full sentence from the button itself (the two short lines and the opened sentence are hidden from them), so nothing is
 * read twice. Each chip wears its voucher type's colour (`item.tone`, the picker's rule), free shipping teal.
 */
export function VoucherTeaserChips({ items }: Readonly<{ items: readonly VoucherTeaserItem[] }>) {
  const [open, setOpen] = useState(0);
  const panelId = useId();
  const current = items[open] ?? items[0];
  if (current === undefined) return null;
  return (
    <>
      <ul aria-label="Voucher" className="voucher-chips">
        {items.map((item, index) => (
          <li className={`voucher-tone voucher-tone--${item.tone}`} key={item.id}>
            <button type="button" className="voucher-chip" aria-pressed={index === open} aria-controls={panelId} onClick={() => setOpen(index)}>
              <span aria-hidden="true" className="voucher-chip__icon"><VoucherIcon name={item.kind === "SHIPPING_FREE" ? "truck" : "tag"} /></span>
              <span aria-hidden="true" className="voucher-chip__text voucher-chip__text--stack">
                <b>{item.title}</b>
                {item.sub ? <small>{item.sub}</small> : null}
              </span>
              <span className="sr-only">{item.text}</span>
            </button>
          </li>
        ))}
      </ul>
      <p aria-hidden="true" className={`voucher-chip-info voucher-tone voucher-tone--${current.tone}`} id={panelId}>{current.text}</p>
    </>
  );
}
