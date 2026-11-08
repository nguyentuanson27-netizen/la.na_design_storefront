"use client";
import Image from "next/image";
import type { ReactNode } from "react";

/**
 * The gifts sit in a three-column grid. A closed card is a small portrait tile (photo over name, the `+` on the photo's corner, the whole tile one button); the open card is
 * the one being chosen from and takes the full row, photo beside the name and `chips` (the version picker) so it
 * stays short on a phone; `children` is the rest of the card below. The grid packs densely so the tile before an
 * open card is not left alone in its row.
 */
export function GiftProductCard({ name, imageUrl, open, onOpen, chips, children }: Readonly<{name: string; imageUrl: string | null; open: boolean; onOpen: () => void; chips?: ReactNode; children: ReactNode}>) {
  // The open card is the one being chosen from: the gift colour ring and a warm tint set it apart.
  return <article className={`relative min-w-0 rounded-lg transition-colors ${open ? "p-3 col-span-3 bg-[#f7f1e6] shadow-[inset_0_0_0_2px_#8a5a2b]" : "p-2 bg-[#fffdfa] shadow-[inset_0_0_0_1px_rgba(59,34,25,0.22)]"}`}>
    <div className={open ? "flex items-start gap-4" : "flex flex-col gap-2"}>
      {imageUrl
        ? <Image src={imageUrl} alt="" width={64} height={80} sizes={open ? "64px" : "(min-width: 640px) 220px, 45vw"} className={open ? "h-20 w-16 shrink-0 rounded-md object-cover" : "aspect-[4/5] h-auto w-full rounded-md object-cover"} />
        : <span aria-hidden="true" className={`flex shrink-0 items-center justify-center rounded-md bg-black/5 text-xs ${open ? "h-20 w-16" : "aspect-[4/5] w-full"}`}>Quà</span>}
      <div className="min-w-0 flex-1">
        <button type="button" aria-expanded={open} onClick={onOpen} className={`flex w-full text-left ${open ? "min-h-11 items-center gap-2" : "min-h-9 items-start after:absolute after:inset-0 after:content-['']"}`}>
          <span className={`min-w-0 flex-1 break-words font-semibold ${open ? "text-sm" : "text-xs leading-snug"}`}>{name}</span><span aria-hidden="true" className={`grid h-6 w-6 shrink-0 place-items-center rounded-full border text-sm leading-none ${open ? "border-black/25" : "absolute right-3 top-3 border-white/80 bg-white/90 shadow-sm"}`}>{open ? "−" : "+"}</span>
        </button>
        {open && chips ? <div className="mt-1">{chips}</div> : null}
      </div>
    </div>
    {open ? <div className="mt-3 border-t border-black/10 pt-3">{children}</div> : null}
  </article>;
}
