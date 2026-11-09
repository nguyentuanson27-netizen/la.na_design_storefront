"use client";
import Image from "next/image";
import type { ReactNode } from "react";
import { useT } from "@/i18n/client";

/**
 * The gifts sit in a three-column grid of portrait tiles (photo over name, the `+` on the photo's corner, the whole tile one
 * button). A tile never moves: opening one rings it in the gift colour, and its details (`GiftProductDetail`) take a full row
 * placed right AFTER the row the tile is in. So what the shopper sees, the DOM and the Tab order are always the same sequence
 * (no dense packing that would lift a later tile above an earlier one), and no tile is left alone in a row.
 */
export function GiftProductCard({ name, imageUrl, open, onOpen }: Readonly<{ name: string; imageUrl: string | null; open: boolean; onOpen: () => void }>) {
  const t = useT();
  return <article className={`relative min-w-0 rounded-lg p-2 transition-colors ${open ? "bg-[#f7f1e6] shadow-[inset_0_0_0_2px_#8a5a2b]" : "bg-[#fffdfa] shadow-[inset_0_0_0_1px_rgba(59,34,25,0.22)]"}`}>
    <div className="flex flex-col gap-2">
      {imageUrl
        ? <Image src={imageUrl} alt="" width={64} height={80} sizes="(min-width: 640px) 160px, 30vw" className="aspect-[4/5] h-auto w-full rounded-md object-cover" />
        : <span aria-hidden="true" className="flex aspect-[4/5] w-full shrink-0 items-center justify-center rounded-md bg-black/5 text-xs">{t("Quà")}</span>}
      <button type="button" aria-expanded={open} onClick={onOpen} className="flex min-h-9 w-full items-start text-left after:absolute after:inset-0 after:content-['']">
        <span className="min-w-0 flex-1 break-words text-xs font-semibold leading-snug">{name}</span>
        <span aria-hidden="true" className="absolute right-3 top-3 grid h-6 w-6 place-items-center rounded-full border border-white/80 bg-white/90 text-sm leading-none shadow-sm">{open ? "−" : "+"}</span>
      </button>
    </div>
  </article>;
}

/** The open gift's details, one full grid row: its photo beside its name and `chips` (the version picker), then `children`. */
export function GiftProductDetail({ name, imageUrl, chips, children }: Readonly<{ name: string; imageUrl: string | null; chips?: ReactNode; children: ReactNode }>) {
  const t = useT();
  return <div role="group" aria-label={name} className="col-span-3 min-w-0 rounded-lg bg-[#f7f1e6] p-3 shadow-[inset_0_0_0_2px_#8a5a2b]" data-gift-detail>
    <div className="flex items-start gap-4">
      {imageUrl
        ? <Image src={imageUrl} alt="" width={64} height={80} sizes="64px" className="h-20 w-16 shrink-0 rounded-md object-cover" />
        : <span aria-hidden="true" className="flex h-20 w-16 shrink-0 items-center justify-center rounded-md bg-black/5 text-xs">{t("Quà")}</span>}
      <div className="min-w-0 flex-1">
        <p className="break-words font-display text-sm font-semibold">{name}</p>
        {chips ? <div className="mt-2">{chips}</div> : null}
      </div>
    </div>
    <div className="mt-3 border-t border-black/10 pt-3">{children}</div>
  </div>;
}
