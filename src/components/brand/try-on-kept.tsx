"use client";

import { useState } from "react";

import type { TryOnKeptResult } from "@/components/headless/try-on-session";

import { BrandTryOnSaveActions, useCanShareTryOnFiles } from "./try-on-result";
import { BrandTryOnZoom } from "./try-on-zoom";

const FOCUS_RING =
  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#3B2219]";

/**
 * The pictures the shopper has already looked at in this tab (`try-on-session.tsx`, `kept`), so a
 * second garment can be set against the first. Each is a thumbnail that opens full screen, where it
 * can be saved or shared; × lets go of one. It says plainly that they are held only in this
 * browser tab: a reload or a closed tab drops them, and nothing is stored on La.na's side.
 */
export function BrandTryOnKept({
  items,
  onRemove,
}: Readonly<{ items: readonly TryOnKeptResult[]; onRemove: (id: number) => void }>) {
  const [openId, setOpenId] = useState<number | null>(null);
  const canShare = useCanShareTryOnFiles();
  if (items.length === 0) return null;
  const opened = items.find((item) => item.id === openId) ?? null;

  return (
    <section aria-label="Ảnh đã thử trước đó" className="mt-4 border-t border-black/10 pt-3">
      <h4 className="text-[13px] font-semibold">Ảnh nàng đã thử</h4>
      <ul className="mt-2 flex gap-2.5 overflow-x-auto pb-1">
        {items.map((item) => (
          <li key={item.id} className="relative shrink-0">
            <button
              type="button"
              aria-label={`Xem lại ảnh thử ${item.productName}`}
              className={`block ${FOCUS_RING}`}
              onClick={() => setOpenId(item.id)}
            >
              {/* eslint-disable-next-line @next/next/no-img-element -- a local blob; next/image cannot optimise it. */}
              <img
                src={item.result.url}
                alt=""
                className="h-24 w-[4.5rem] border border-black/15 object-cover"
              />
              <span className="mt-1 block w-[4.5rem] truncate text-left text-[11px] text-black/65">
                {item.productName}
              </span>
            </button>
            <button
              type="button"
              aria-label={`Bỏ ảnh thử ${item.productName}`}
              className={`absolute right-0 top-0 flex h-6 w-6 items-center justify-center bg-[#FAF7F2]/90 text-sm leading-none text-[#3B2219] ${FOCUS_RING}`}
              onClick={() => onRemove(item.id)}
            >
              <span aria-hidden="true">×</span>
            </button>
          </li>
        ))}
      </ul>
      <p className="mt-1 text-[11px] leading-4 text-black/55">
        Chỉ lưu tạm trên trình duyệt này, tải lại trang là mất.
      </p>
      {opened ? (
        <BrandTryOnZoom
          open
          onClose={() => setOpenId(null)}
          afterUrl={opened.result.url}
          beforeUrl={null}
          alt={`Ảnh thử đồ do AI tạo cho ${opened.productName}, chỉ mang tính tham khảo`}
          actions={
            <div className={`grid gap-2 ${canShare ? "grid-cols-2" : "grid-cols-1"}`}>
              <BrandTryOnSaveActions
                result={opened.result}
                productName={opened.productName}
                productSlug={opened.productSlug}
                canShare={canShare}
                className="btn btn--outline border-white/60 px-3 text-white hover:text-black"
              />
            </div>
          }
        />
      ) : null}
    </section>
  );
}
