"use client";

import Image from "next/image";
import { useEffect, useId, useRef, useState } from "react";
import { useCartGifts } from "@/components/headless/use-cart-gifts";
import type { CartGiftPickerModel } from "@/routes/cart-gift-model";
import { GiftProductCard } from "./gift-product-card";

/**
 * The version the buyer is looking at. `committed` marks a draft the server has confirmed saving at
 * least once: removing that gift later is a finished action, not an unsaved choice to warn about.
 */
type Draft = { campaignId: string; variantId: string; label: string; committed?: boolean };
export function BrandCartGiftPicker({ model, onBusyChange, locked = false, isLocked, onDraftChange, onReturnToPayment }: Readonly<{
  model: CartGiftPickerModel; onBusyChange?: (pending: boolean) => void; locked?: boolean;
  isLocked?: () => boolean; onDraftChange?: (notice: string | null) => void; onReturnToPayment?: () => void;
}>) {
  const { pending, uncertain, message, savedCount, change, retryRead } = useCartGifts(onBusyChange, locked, isLocked);
  const [expanded, setExpanded] = useState(false);
  // The `savedCount` a receive started from: collapse only once a later save is confirmed, never on a
  // refusal or read-back while an older choice of the same gift is still in the model.
  const [collapseFromSave, setCollapseFromSave] = useState<number | null>(null);
  const [collapseFocus, setCollapseFocus] = useState(0);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const detailsRef = useRef<HTMLDivElement>(null);
  const [card, setCard] = useState("");
  const [draft, setDraft] = useState<Draft | null>(null);
  const detailsId = useId();
  const giftArea = useRef<HTMLElement>(null);
  const removalFocus = useRef<{ control: HTMLButtonElement; moved: boolean } | null>(null);
  useEffect(() => {
    const leave = () => { if (removalFocus.current) removalFocus.current.moved = true; };
    const focusMoved = (event: FocusEvent) => {
      // Disabling/removing the initiating button can leave focus on BODY without buyer intent.
      if (removalFocus.current && event.target !== document.body && event.target !== removalFocus.current.control) leave();
    };
    const pointerMoved = (event: PointerEvent) => {
      if (removalFocus.current && event.target instanceof Node && !removalFocus.current.control.contains(event.target)) leave();
    };
    const tabMoved = (event: KeyboardEvent) => { if (event.key === "Tab") leave(); };
    document.addEventListener("focusin", focusMoved);
    document.addEventListener("pointerdown", pointerMoved);
    document.addEventListener("keydown", tabMoved);
    return () => {
      removalFocus.current = null;
      document.removeEventListener("focusin", focusMoved);
      document.removeEventListener("pointerdown", pointerMoved);
      document.removeEventListener("keydown", tabMoved);
    };
  }, []);
  useEffect(() => {
    const origin = removalFocus.current;
    // A transition finishes after the refreshed model is installed. Unknown writes must read back.
    if (!origin || pending || uncertain) return;
    removalFocus.current = null;
    if (origin.moved || (document.activeElement !== document.body && document.activeElement !== origin.control)) return;
    const target = origin.control.isConnected && !origin.control.disabled && !origin.control.closest("[hidden]")
      ? origin.control : giftArea.current;
    target?.focus({ preventScroll: true });
  }, [pending, uncertain]);
  function removeGift(control: HTMLButtonElement, ...choice: Parameters<typeof change>) {
    const focused = document.activeElement === control;
    if (change(...choice)) removalFocus.current = focused ? { control, moved: false } : null;
  }
  function retryGiftRead(control: HTMLButtonElement) {
    // Explicitly retrying inside the gift area establishes a new focus origin for this removal.
    if (removalFocus.current && !pending && document.activeElement === control) removalFocus.current = { control, moved: false };
    retryRead();
  }
  const selected = model.selections.reduce((sum, row) => sum + row.quantity, 0);
  const entitled = model.campaigns.reduce((sum, row) => sum + row.entitled, 0);
  const unclaimed = model.campaigns.reduce((sum, row) => sum + row.unclaimed, 0);
  const unavailable = model.campaigns.reduce((sum, row) => sum + row.unavailableSlots, 0);
  // Shared capacity is attributed by the existing engine. Never sum competing campaign maxima.
  const shared = model.campaigns.some((row) => row.contendedSlots > 0);
  const available = model.campaigns.reduce((sum, row) => sum + (row.selectable ?? 0), 0);
  const complete = !model.invalid && selected >= entitled && entitled > 0;
  const draftSaved = draft && model.selections.some((row) => row.campaignId === draft.campaignId && row.variantId === draft.variantId);
  if (collapseFromSave !== null && savedCount > collapseFromSave && !pending && !uncertain && draftSaved) {
    setExpanded(false);
    setCard("");
    setCollapseFromSave(null);
    setCollapseFocus((n) => n + 1);
  }
  useEffect(() => {
    if (collapseFocus === 0) return;
    // Only when focus was left behind by the list that just closed (or dropped to BODY with it); a buyer
    // who has already moved elsewhere keeps their place.
    const active = document.activeElement;
    if (active === document.body || (active && detailsRef.current?.contains(active))) toggleRef.current?.focus({ preventScroll: true });
  }, [collapseFocus]);
  // UX-04: the intent ends only on a confirmed (or read-back) model that contains it. A newer chip the
  // buyer picks replaces the draft object, so it starts uncommitted and keeps its own notice.
  if (draft && draftSaved && !draft.committed) setDraft({ ...draft, committed: true });
  const draftNotice = draft && !draftSaved && !draft.committed ? `Phiên bản ${draft.label} chưa được thêm. Đơn chỉ gồm quà đã lưu.` : null;
  useEffect(() => { onDraftChange?.(draftNotice); }, [draftNotice, onDraftChange]);
  const replaced = model.replaced ?? [];
  const present = entitled > 0 || model.selections.length > 0 || replaced.length > 0;
  // UX-05: arriving on `#cart-gifts` (the mini-cart's "Chọn quà") opens the picker and puts focus on it.
  // Opening only reveals the choices; nothing is selected or saved on the buyer's behalf. Focus is asked
  // for through state and applied after the commit that shows the picker, so no effect cleanup can drop it.
  const [focusRequest, setFocusRequest] = useState(0);
  useEffect(() => {
    if (focusRequest === 0) return;
    giftArea.current?.scrollIntoView({ block: "start" });
    giftArea.current?.focus({ preventScroll: true });
  }, [focusRequest]);
  const arrivalChecked = useRef(false);
  useEffect(() => {
    if (!present) return;
    const page = window.location.pathname;
    const open = () => { setExpanded(true); setFocusRequest((n) => n + 1); };
    // Only for this page: a history event that lands on another page's `#cart-gifts` is not ours.
    const openIfTargeted = () => { if (window.location.pathname === page && window.location.hash === "#cart-gifts") open(); };
    // Once per mount, on the first render that has a picker: a picker that reappears later while the URL
    // still carries the hash must not scroll the page or take focus on its own.
    if (!arrivalChecked.current) {
      arrivalChecked.current = true;
      openIfTargeted();
    }
    // Next's <Link> commits its URL change later, inside a transition, so the click is judged by the link's
    // own target rather than by `location`: a plain left click on a same-page `#cart-gifts` link opens now.
    const linkClicked = (event: MouseEvent) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const link = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a[href]") : null;
      if (!link || (link.target && link.target !== "_self")) return;
      const url = new URL(link.href, window.location.href);
      if (url.origin === window.location.origin && url.pathname === page && url.hash === "#cart-gifts") open();
    };
    window.addEventListener("hashchange", openIfTargeted);
    window.addEventListener("popstate", openIfTargeted);
    document.addEventListener("click", linkClicked);
    return () => {
      window.removeEventListener("hashchange", openIfTargeted);
      window.removeEventListener("popstate", openIfTargeted);
      document.removeEventListener("click", linkClicked);
    };
  }, [present]);
  if (!present && !message) return null;
  const busy = pending || uncertain;
  return <section ref={giftArea} id="cart-gifts" tabIndex={-1} className={present ? "my-6 min-w-0 scroll-mt-32 border border-black/20 bg-[#fcf8f6] p-4 sm:p-5" : "my-4 scroll-mt-32 text-sm"} aria-label="Quà tặng trong giỏ" aria-busy={busy}>
    {present ? <>
    <h2 className="font-display text-2xl">Quà dành cho nàng</h2>
    <p className="mt-2 text-sm" data-gift-progress>{model.invalid ? `Đã lưu ${selected} quà · Cần kiểm tra` : `Đã thêm ${selected}/${entitled} quà vào đơn.`}</p>
    {model.invalid ? <p role="alert" className="mt-3 text-sm">Quà nàng chọn không còn phù hợp vì giỏ hàng đã thay đổi (số lượng, sản phẩm), quà đã hết hàng hoặc chương trình đã đổi. Nàng bấm “Bỏ quà để chọn lại” ở danh sách quà đã chọn rồi chọn món mới nhé; hệ thống không tự đổi quà thay nàng.</p> : <>
      {!complete && available > 0 ? <p className="mt-2 text-sm">{shared ? "Nàng còn quà chưa chọn. Các chương trình dùng chung lượng quà, nàng chọn từng món để cập nhật nhé." : `Nàng còn có thể chọn ${available} món quà.`}</p> : null}
      {unavailable > 0 ? <p className="mt-2 text-sm">Hiện chưa có lựa chọn phù hợp cho {unavailable} suất quà còn lại.</p> : null}
    </>}
    {replaced.length > 0 ? <p className="mt-3 text-sm" data-gift-replaced-notice>Đơn của nàng đã lên mốc quà cao hơn nên quà đã chọn ở mốc trước không đi kèm đơn nữa. Nàng chọn quà của mốc mới, quà cũ sẽ được thay.</p> : null}
    {model.stackConflict ? <p role="alert" className="mt-3 text-sm">Giỏ hàng của nàng đủ điều kiện nhận quà từ nhiều chương trình, nhưng các chương trình này không được dùng cùng lúc nên một số quà chưa được tặng. Nàng điều chỉnh lại giỏ hàng hoặc liên hệ shop để được hỗ trợ nhé.</p> : null}
    <button type="button" ref={toggleRef} className="mt-3 min-h-11 text-left text-sm font-semibold underline underline-offset-4" aria-expanded={expanded} aria-controls={detailsId} onClick={() => setExpanded((value) => !value)}>
      {expanded ? "Thu gọn quà tặng" : model.invalid ? "Kiểm tra quà đã chọn" : complete ? "Xem quà đã chọn" : available > 0 ? "Chọn quà ngay" : "Xem lựa chọn quà"}
    </button>
    <div id={detailsId} ref={detailsRef} hidden={!expanded}>
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
          {row.quantity > 1 ? <button type="button" className="min-h-11 text-sm underline" disabled={busy || locked} onClick={(event) => removeGift(event.currentTarget, row.campaignId, row.variantId, row.campaignRevision, row.quantity - 1, row.label, 1)}>Bỏ 1 chiếc để chọn lại: {row.label}</button> : null}
          <button type="button" className="min-h-11 text-left text-sm underline" disabled={busy || locked} onClick={(event) => removeGift(event.currentTarget, row.campaignId, row.variantId, row.campaignRevision, 0, row.label, row.quantity)}>{row.quantity > 1 ? `Bỏ toàn bộ ${row.quantity} chiếc` : "Bỏ quà để chọn lại"}: {row.label}</button>
        </div>
      </div>)}
      {replaced.map((row) => <div className="mt-4 border-t border-black/15 pt-4" key={`replaced-${row.campaignId}-${row.variantId}`} data-gift-replaced={`${row.campaignId}/${row.variantId}`}>
        <div className="flex items-center gap-3">
          {row.imageUrl ? <Image src={row.imageUrl} alt="" width={40} height={50} className="h-[50px] w-10 object-cover opacity-60" /> : null}
          <p className="min-w-0 break-words text-sm">Quà mốc trước: {row.label} · {row.quantity} quà</p>
        </div>
        <p className="mt-2 text-xs leading-5">Không đi kèm đơn ở mốc hiện tại. Sẽ được thay khi nàng nhận quà của mốc mới.</p>
        <button type="button" className="mt-2 min-h-11 text-left text-sm underline" disabled={busy || locked} onClick={(event) => removeGift(event.currentTarget, row.campaignId, row.variantId, row.campaignRevision, 0, row.label, row.quantity)}>Bỏ hẳn quà mốc trước: {row.label}</button>
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
          const receiveBlockReason = uncertain ? "Chưa xác nhận được kết quả lưu quà. Nàng kiểm tra lại quà trong đơn trước khi tiếp tục nhé."
            : pending ? "Đang thêm quà vào đơn hàng, nàng đợi một chút nhé…"
            : locked ? "Nàng chưa chọn quà được lúc này vì đơn hàng đang được xử lý hoặc cần nàng xem lại. Nàng đợi vài giây cho hệ thống cập nhật xong; nếu vẫn chưa chọn được, nàng đọc thông báo ở đầu trang thanh toán và làm theo hướng dẫn nhé."
            : model.invalid ? "Nàng bấm “Bỏ quà để chọn lại” ở danh sách quà đã chọn để bỏ món không còn phù hợp, rồi mới chọn món mới được nhé."
            : campaign.selected >= campaign.entitled ? "Đã đủ suất. Nàng vẫn có thể xem mẫu khác; bỏ quà cũ trước khi nhận lại."
            : !option ? "Chọn phiên bản trước khi nhận quà."
            : !campaign.allowDuplicateGifts && productChosen ? "Nàng đã chọn mẫu này. Mỗi mẫu chỉ được nhận một lần, kể cả khác màu hoặc kích cỡ."
            : option.stock <= stockChosen ? "Phiên bản này không còn đủ hàng để nhận thêm. Nàng chọn phiên bản khác nhé."
            : null;
          const receiveReasonId = `${detailsId}-${index}-${product.productId}-receive-reason`;
          return <GiftProductCard key={product.productId} name={product.name} imageUrl={product.imageUrl} open={card === key} chipsBelow={product.options.length > 3} chips={<div className="flex flex-wrap gap-1" role="group" aria-label={`Phiên bản ${product.name}`}>{product.options.map((o) => <button type="button" key={o.variantId} aria-label={`${product.name} — ${o.label}`} aria-pressed={option?.variantId === o.variantId} className="group min-h-9 min-w-9 border border-black/30 px-2 py-0.5 text-xs leading-5 aria-pressed:bg-[#634936] aria-pressed:text-white sm:text-sm" onClick={() => setDraft({campaignId: campaign.campaignId, variantId: o.variantId, label: `${product.name} — ${o.label}`})}>{o.color && o.size ? <>{o.color} <span className="text-black/40 group-aria-pressed:text-white/70">/</span> {o.size}</> : o.label}</button>)}</div>} onOpen={() => {
            setCard(card === key ? "" : key);
            if (product.options.length === 1) setDraft({campaignId: campaign.campaignId, variantId: product.options[0]!.variantId, label: `${product.name} — ${product.options[0]!.label}`});
          }}>
            {option ? <p className="mt-3 text-sm">{uncertain ? "Đang chờ kiểm tra kết quả lưu quà…" : pending ? "Đang cập nhật quà…" : chosen > 0 ? "Đã thêm vào đơn" : "Chưa thêm vào đơn"}</p> : <p className="mt-3 text-sm">Chọn phiên bản để xem.</p>}
            {receiveBlockReason ? <p id={receiveReasonId} className="mt-2 text-xs" aria-live="polite">{receiveBlockReason}</p> : null}
            <button type="button" className="btn btn--secondary mt-3 min-h-10 w-full py-1.5" disabled={receiveBlockReason !== null} aria-describedby={receiveBlockReason ? receiveReasonId : undefined} onClick={() => {
              if (!option) return;
              // A new receive is a new intent: until the server confirms it, an earlier save no longer covers it.
              if (draft?.committed) setDraft({ ...draft, committed: false });
              if (change(campaign.campaignId, option.variantId, campaign.revision, chosen + 1, `${product.name} — ${option.label}`, 0)) setCollapseFromSave(savedCount);
            }}>Nhận quà này</button>
          </GiftProductCard>;
        })}</div>
      </div>)}
    </div>
    {/* Outside the collapsible list: after a confirmed save collapses it, the way back to payment stays reachable. */}
    {onReturnToPayment ? <button type="button" className="mt-4 min-h-11 text-sm underline" onClick={onReturnToPayment}>Quay lại thanh toán</button> : null}
    {draftNotice ? <p className="mt-3 text-sm" data-gift-draft>{draftNotice}</p> : null}
    </> : null}
    <p className="mt-3 text-sm" role="status" aria-live="polite" aria-atomic="true">{pending ? "Đang kiểm tra và làm mới báo giá…" : message}{present && !pending && !uncertain && message && !model.invalid ? ` Còn ${unclaimed} suất chưa chọn.` : ""}</p>
    {uncertain ? <button type="button" className="mt-2 min-h-11 text-sm underline" disabled={pending} onClick={(event) => retryGiftRead(event.currentTarget)}>Kiểm tra lại quà trong đơn</button> : null}
  </section>;
}
