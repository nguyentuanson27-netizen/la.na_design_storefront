import type { VoucherTeaserItem } from "@/commerce/voucher-teaser";
import { VoucherIcon } from "./voucher-icons";

/**
 * Voucher v1 (V17, UI refresh): the PDP teaser as small tickets in one swipeable row. Each shows two short lines ("Giảm 200K" over
 * "Đơn từ 1,5 triệu"). They are plain labels, not buttons: there is no longer a sentence to open below them. It states a voucher's own conditions
 * only and promises nothing: whether a cart qualifies is decided in the cart.
 *
 * Screen readers get the full sentence from a visually hidden copy (the two short lines are hidden from them), so nothing is read twice.
 * Each chip wears its voucher type's colour (`item.tone`, the picker's rule), free shipping teal.
 */
export function VoucherTeaserChips({ items }: Readonly<{ items: readonly VoucherTeaserItem[] }>) {
  if (items.length === 0) return null;
  return (
    <ul aria-label="Voucher" className="voucher-chips">
      {items.map((item) => (
        <li className={`voucher-chip voucher-tone voucher-tone--${item.tone}`} key={item.id}>
          <span aria-hidden="true" className="voucher-chip__icon"><VoucherIcon name={item.kind === "SHIPPING_FREE" ? "truck" : "tag"} /></span>
          <span aria-hidden="true" className="voucher-chip__text voucher-chip__text--stack">
            <b>{item.title}</b>
            {item.sub ? <small>{item.sub}</small> : null}
          </span>
          <span className="sr-only">{item.text}</span>
        </li>
      ))}
    </ul>
  );
}
