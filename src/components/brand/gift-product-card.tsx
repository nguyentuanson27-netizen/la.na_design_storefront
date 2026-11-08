"use client";
import Image from "next/image";
import type { ReactNode } from "react";

/**
 * `chips` (the version picker) sits in the header beside the photo, under the name, so the open card
 * stays short on a phone; `children` is the rest of the card below.
 */
export function GiftProductCard({ name, imageUrl, open, onOpen, chips, children }: Readonly<{name: string; imageUrl: string | null; open: boolean; onOpen: () => void; chips?: ReactNode; children: ReactNode}>) {
  // The open card is the one being chosen from: the gift colour ring and a warm tint set it apart.
  return <article className={`min-w-0 rounded-lg p-3 transition-colors ${open ? "bg-[#f7f1e6] shadow-[inset_0_0_0_2px_#7a5c14]" : "bg-[#fffdfa] shadow-[inset_0_0_0_1px_rgba(59,34,25,0.22)]"}`}>
    <div className={open ? "flex items-start gap-4" : "flex items-center gap-4"}>
      {imageUrl ? <Image src={imageUrl} alt="" width={64} height={80} className="h-20 w-16 shrink-0 rounded-md object-cover" /> : <span aria-hidden="true" className="flex h-20 w-16 shrink-0 items-center justify-center rounded-md bg-black/5 text-xs">Quà</span>}
      <div className="min-w-0 flex-1">
        <button type="button" aria-expanded={open} onClick={onOpen} className="flex min-h-11 w-full items-center gap-4 text-left">
          <span className="min-w-0 flex-1 break-words text-sm font-semibold">{name}</span><span aria-hidden="true" className="grid h-6 w-6 shrink-0 place-items-center rounded-full border border-black/25 text-sm leading-none">{open ? "−" : "+"}</span>
        </button>
        {open && chips ? <div className="mt-1">{chips}</div> : null}
      </div>
    </div>
    {open ? <div className="mt-3 border-t border-black/10 pt-3">{children}</div> : null}
  </article>;
}
