import type { VoucherPickerItem } from "@/routes/voucher-picker-model";

/**
 * One voucher row of the picker (spec §7.3). A semantic radio inside a label: the selected state is the radio's own
 * (not just colour), an unavailable voucher is a disabled radio with its reason in text, and the whole row is a
 * 44px+ touch target. Nothing here knows about money or eligibility -- it renders what the server model says.
 */
export function VoucherCard({ item, name, onSelect, disabled }: Readonly<{
  item: VoucherPickerItem;
  name: string;
  onSelect: () => void;
  disabled: boolean;
}>) {
  const descriptionId = `${name}-${item.id}-desc`;
  const unavailable = !item.selectable;
  return (
    <li>
      <label
        className={`flex min-h-14 cursor-pointer items-start gap-3 border px-3 py-3 ${item.selected ? "border-black" : "border-black/20"} ${unavailable ? "cursor-not-allowed opacity-70" : ""}`}
      >
        <input
          type="radio"
          name={name}
          value={item.id}
          checked={item.selected}
          disabled={unavailable || disabled}
          onChange={onSelect}
          aria-describedby={descriptionId}
          className="mt-1 h-5 w-5 shrink-0 accent-black"
        />
        <span className="min-w-0 flex-1">
          <span className="block text-base font-semibold">{item.title}</span>
          <span id={descriptionId} className="mt-0.5 block text-sm leading-5 text-black/75">
            {item.condition}
            {item.publicCode ? <span className="ml-2 border border-black/30 px-1.5 text-xs font-semibold tracking-wide">{item.publicCode}</span> : null}
            {item.disabledReason ? <span className="mt-1 block font-medium text-black">{item.disabledReason}</span> : null}
            {!unavailable && item.savingText ? <span className="mt-1 block font-semibold text-[#b42318]"><span className="sr-only">Dự kiến giảm </span><span aria-hidden="true">{item.savingText}</span></span> : null}
          </span>
        </span>
      </label>
    </li>
  );
}
