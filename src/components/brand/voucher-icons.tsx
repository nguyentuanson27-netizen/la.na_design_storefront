/**
 * Voucher v1 (UI refresh): the few line icons the voucher surfaces share. Decorative (aria-hidden): the words beside them carry the
 * meaning. They draw in `currentColor`, so the surface sets the colour.
 */

const PATHS = {
  tag: <><path d="M3 12V4h8l10 10-8 8L3 12z" /><circle cx="7.5" cy="8.5" r="1.2" /></>,
  truck: <><path d="M2 6h11v9H2zM13 9h4l3 3v3h-7z" /><circle cx="6" cy="17.5" r="2" /><circle cx="16.5" cy="17.5" r="2" /></>,
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  down: <><circle cx="12" cy="12" r="9" /><path d="M12 7.5v8M8.5 12.5l3.5 3.5 3.5-3.5" /></>,
  chevron: <path d="M9 5l7 7-7 7" />,
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
} as const;

export type VoucherIconName = keyof typeof PATHS;

export function VoucherIcon({ name, className }: Readonly<{ name: VoucherIconName; className?: string }>) {
  return (
    <svg aria-hidden="true" className={className} fill="none" focusable="false" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" viewBox="0 0 24 24">
      {PATHS[name]}
    </svg>
  );
}
