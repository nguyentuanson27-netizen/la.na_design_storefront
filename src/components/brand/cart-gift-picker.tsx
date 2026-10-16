"use client";

import Image from "next/image";
import { useEffect, useId, useState } from "react";
import { useCartGifts } from "@/components/headless/use-cart-gifts";
import type { CartGiftPickerModel } from "@/routes/cart-gift-model";
import { GiftProductCard } from "./gift-product-card";

type Draft = { campaignId: string; variantId: string; label: string };
export function BrandCartGiftPicker({ model, onBusyChange, locked = false, isLocked, onDraftChange, onReturnToPayment }: Readonly<{
  model: CartGiftPickerModel; onBusyChange?: (pending: boolean) => void; locked?: boolean;
  isLocked?: () => boolean; onDraftChange?: (notice: string | null) => void; onReturnToPayment?: () => void;
}>) {
  const { pending, uncertain, message, change, retryRead } = useCartGifts(onBusyChange, locked, isLocked);
  const [expanded, setExpanded] = useState(false);
  const [card, setCard] = useState("");
  const [draft, setDraft] = useState<Draft | null>(null);
  const detailsId = useId();
  const selected = model.selections.reduce((sum, row) => sum + row.quantity, 0);
  const entitled = model.campaigns.reduce((sum, row) => sum + row.entitled, 0);
  const unclaimed = model.campaigns.reduce((sum, row) => sum + row.unclaimed, 0);
  const unavailable = model.campaigns.reduce((sum, row) => sum + row.unavailableSlots, 0);
  // Shared capacity is attributed by the existing engine. Never sum competing campaign maxima.
  const shared = model.campaigns.some((row) => row.contendedSlots > 0);
  const available = model.campaigns.reduce((sum, row) => sum + (row.selectable ?? 0), 0);
  const complete = !model.invalid && selected >= entitled && entitled > 0;
  const draftSaved = draft && model.selections.some((row) => row.campaignId === draft.campaignId && row.variantId === draft.variantId);
  const draftNotice = draft && !draftSaved ? `Phiên bản ${draft.label} chưa được thêm. Đơn chỉ gồm quà đã lưu.` : null;
  useEffect(() => { onDraftChange?.(draftNotice); }, [draftNotice, onDraftChange]);
  const present = entitled > 0 || model.selections.length > 0;
  if (!present) return message ? <div className="my-4 text-sm">
    <p role="status" aria-live="polite">{pending ? "Đang kiểm tra và làm mới báo giá…" : message}</p>
    {uncertain ? <button type="button" className="min-h-11 underline" disabled={pending} onClick={retryRead}>Kiểm tra lại quà trong đơn</button> : null}
  </div> : null;
  const busy = pending || uncertain;
  return <section id="cart-gifts" tabIndex={-1} className="my-6 min-w-0 scroll-mt-32 border border-black/20 bg-[#fcf8f6] p-4 sm:p-5" aria-label="Quà tặng trong giỏ" aria-busy={busy}>
    <h2 className="font-display text-2xl">Quà dành cho bạn</h2>
    <p className="mt-2 text-sm" data-gift-progress>{model.invalid ? `Đã lưu ${selected} quà · Cần kiểm tra` : `Đã thêm ${selected}/${entitled} quà vào đơn.`}</p>
    {model.invalid ? <p role="alert" className="mt-3 text-sm">Quà đã chọn không còn phù hợp với giỏ hàng, chương trình hoặc tồn kho. Hãy bỏ lựa chọn cũ tại đây rồi chọn lại; chúng tôi không tự thay quà.</p> : <>
      {!complete && available > 0 ? <p className="mt-2 text-sm">{shared ? "Bạn còn quà chưa chọn. Các chương trình dùng chung lượng quà; hãy chọn từng món để cập nhật quyền nhận." : `Bạn còn có thể chọn ${available} món quà.`}</p> : null}
      {unavailable > 0 ? <p className="mt-2 text-sm">Hiện chưa có lựa chọn phù hợp cho {unavailable} suất quà còn lại.</p> : null}
    </>}
    {model.stackConflict ? <p role="alert" className="mt-3 text-sm">Các chương trình quà chưa được phép kết hợp. Chưa thể cấp quà; vui lòng thử lại sau.</p> : null}
    <button type="button" className="mt-3 min-h-11 text-left text-sm font-semibold underline underline-offset-4" aria-expanded={expanded} aria-controls={detailsId} onClick={() => setExpanded((value) => !value)}>
      {expanded ? "Thu gọn quà tặng" : model.invalid ? "Kiểm tra quà đã chọn" : complete ? "Xem quà đã chọn" : available > 0 ? "Chọn quà ngay" : "Xem lựa chọn quà"}
    </button>
    <div id={detailsId} hidden={!expanded}>
      {model.repairGroups?.map((group, index) => <div key={index} role="group" aria-label="Nhóm quà cần kiểm tra" className="mt-4 border border-[#b42318]/40 p-3 text-sm">
        <p>{group.message}</p>
        <ul className="mt-2 list-disc pl-5">{model.selections.filter(row => group.selectionKeys.includes(`${row.campaignId}/${row.variantId}`)).map(row => <li key={`${row.campaignId}/${row.variantId}`}>{row.label} · {row.quantity} quà</li>)}</ul>
      </div>)}
      {model.selections.map((row) => <div className="mt-4 border-t border-black/15 pt-4" key={`${row.campaignId}-${row.variantId}`} data-gift-selection={`${row.campaignId}/${row.variantId}`}>
        <div className="flex items-center gap-3">
          {row.imageUrl ? <Image src={row.imageUrl} alt="" width={40} height={50} className="h-[50px] w-10 object-cover" /> : null}
          <p className="min-w-0 break-words text-sm">{row.label} · {row.quantity} quà</p>
        </div>
        {row.problems?.map((problem, index) => <p key={index} data-gift-problem className="mt-2 text-sm text-[#b42318]">Cần xử lý: {problem}</p>)}
        <p className="mt-2 text-xs leading-5">Quà cũ sẽ được bỏ trước. Món chọn lại tùy tình trạng còn hàng.</p>
        <div className="mt-2 flex flex-wrap gap-3">
          {row.quantity > 1 ? <button type="button" className="min-h-11 text-sm underline" disabled={busy || locked} onClick={() => change(row.campaignId, row.variantId, row.campaignRevision, row.quantity - 1, row.label, 1)}>Bỏ 1 chiếc để chọn lại: {row.label}</button> : null}
          <button type="button" className="min-h-11 text-left text-sm underline" disabled={busy || locked} onClick={() => change(row.campaignId, row.variantId, row.campaignRevision, 0, row.label, row.quantity)}>{row.quantity > 1 ? `Bỏ toàn bộ ${row.quantity} chiếc` : "Bỏ quà để chọn lại"}: {row.label}</button>
        </div>
      </div>)}
      {model.campaigns.filter((c) => c.entitled > 0).map((campaign, index) => <div className="mt-5 border-t border-black/15 pt-4" key={campaign.campaignId}>
        <p className="text-sm font-semibold">Quà tặng theo giỏ hàng {index + 1} · Đã thêm {campaign.selected}/{campaign.entitled}</p>
        {!campaign.allowDuplicateGifts ? <p className="mt-2 text-xs">Mỗi mẫu được chọn 1 lần, kể cả khác màu hoặc kích cỡ.</p> : null}
        <div className="mt-3 grid gap-3 md:grid-cols-2 lg:grid-cols-1">{campaign.products.map((product) => {
          const key = `${campaign.campaignId}/${product.productId}`;
          const option = product.options.find((o) => o.variantId === draft?.variantId && draft.campaignId === campaign.campaignId);
          const chosen = model.selections.find((r) => r.campaignId === campaign.campaignId && r.variantId === option?.variantId)?.quantity ?? 0;
          const productChosen = model.selections.some((r) => r.campaignId === campaign.campaignId && product.options.some((o) => o.variantId === r.variantId));
          const stockChosen = model.selections.filter((r) => r.variantId === option?.variantId).reduce((sum, r) => sum + r.quantity, 0);
          const receiveBlockReason = uncertain ? "Chưa xác nhận được kết quả lưu quà. Hãy kiểm tra lại quà trong đơn trước khi tiếp tục."
            : pending ? "Đang cập nhật quà. Vui lòng chờ xác nhận."
            : locked ? "Giỏ hàng đang được cập nhật hoặc cần kiểm tra lại. Hãy hoàn tất bước kiểm tra trước khi nhận quà."
            : model.invalid ? "Cần sửa quà đã chọn. Hãy bỏ lựa chọn không còn hợp lệ trước khi nhận thêm."
            : campaign.selected >= campaign.entitled ? "Đã đủ suất. Bạn vẫn có thể xem mẫu khác; bỏ quà cũ trước khi nhận lại."
            : !option ? "Chọn phiên bản trước khi nhận quà."
            : !campaign.allowDuplicateGifts && productChosen ? "Bạn đã chọn mẫu này. Mỗi mẫu chỉ được nhận một lần, kể cả khác màu hoặc kích cỡ."
            : option.stock <= stockChosen ? "Phiên bản này không còn số lượng có thể nhận thêm. Hãy chọn phiên bản khác."
            : null;
          const receiveReasonId = `${detailsId}-${index}-${product.productId}-receive-reason`;
          return <GiftProductCard key={product.productId} name={product.name} imageUrl={product.imageUrl} open={card === key} onOpen={() => {
            setCard(card === key ? "" : key);
            if (product.options.length === 1) setDraft({campaignId: campaign.campaignId, variantId: product.options[0]!.variantId, label: `${product.name} — ${product.options[0]!.label}`});
          }}>
            <div className="flex flex-wrap gap-2" aria-label={`Phiên bản ${product.name}`}>{product.options.map((o) => <button type="button" key={o.variantId} aria-pressed={option?.variantId === o.variantId} className="min-h-11 border border-black/30 px-3 text-sm aria-pressed:bg-[#634936] aria-pressed:text-white" onClick={() => setDraft({campaignId: campaign.campaignId, variantId: o.variantId, label: `${product.name} — ${o.label}`})}>{o.label}</button>)}</div>
            {option ? <p className="mt-3 text-sm">{uncertain ? "Đang chờ kiểm tra kết quả lưu quà…" : pending ? "Đang cập nhật quà…" : chosen > 0 ? "Đã thêm vào đơn" : "Chưa thêm vào đơn"}</p> : <p className="mt-3 text-sm">Chọn phiên bản để xem.</p>}
            {receiveBlockReason ? <p id={receiveReasonId} className="mt-2 text-xs" aria-live="polite">{receiveBlockReason}</p> : null}
            <button type="button" className="btn btn--secondary mt-3 w-full" disabled={receiveBlockReason !== null} aria-describedby={receiveBlockReason ? receiveReasonId : undefined} onClick={() => option && change(campaign.campaignId, option.variantId, campaign.revision, chosen + 1, `${product.name} — ${option.label}`, 0)}>Nhận quà này</button>
          </GiftProductCard>;
        })}</div>
      </div>)}
      {onReturnToPayment ? <button type="button" className="mt-4 min-h-11 text-sm underline" onClick={onReturnToPayment}>Quay lại thanh toán</button> : null}
    </div>
    {draftNotice ? <p className="mt-3 text-sm" data-gift-draft>{draftNotice}</p> : null}
    <p className="mt-3 text-sm" role="status" aria-live="polite" aria-atomic="true">{pending ? "Đang kiểm tra và làm mới báo giá…" : message}{!pending && !uncertain && message && !model.invalid ? ` Còn ${unclaimed} suất chưa chọn.` : ""}</p>
    {uncertain ? <button type="button" className="mt-2 min-h-11 text-sm underline" disabled={pending} onClick={retryRead}>Kiểm tra lại quà trong đơn</button> : null}
  </section>;
}
