"use client";

import { useCartGifts } from "@/components/headless/use-cart-gifts";
import type { CartGiftPickerModel } from "@/routes/cart-gift-model";

export function BrandCartGiftPicker({ model }: Readonly<{ model: CartGiftPickerModel }>) {
  const { pending, message, products, setProducts, change } = useCartGifts();
  if (!model.campaigns.length && !model.selections.length) return null;
  return <section id="cart-gifts" className="mt-8 scroll-mt-24 border border-black/20 p-5" aria-label="Quà tặng trong giỏ" aria-busy={pending}>
    <h2 className="text-xl font-semibold">Quà tặng trong giỏ</h2>
    <p className="mt-2 text-sm leading-6">Bạn tự chọn quà muốn nhận, hoặc để trống. Bỏ quà ở đây chưa phải xác nhận bỏ quyền lợi khi đặt hàng.</p>
    {model.stackConflict ? <p role="alert" className="mt-3 text-sm">Các chương trình quà chưa được phép kết hợp. Chưa thể cấp quà; vui lòng thử lại sau.</p> : null}
    {model.invalid ? <p role="alert" className="mt-3 text-sm">Quà đã chọn không còn phù hợp với giỏ hàng, chương trình hoặc tồn kho. Hãy bỏ lựa chọn cũ rồi chọn lại; chúng tôi không tự thay quà.</p> : null}
    {model.selections.map((row) => <div className="mt-4 flex flex-wrap items-center justify-between gap-3" key={`${row.campaignId}-${row.variantId}`}>
      <p className="text-sm">{row.label} · {row.quantity} quà</p>
      {row.quantity > 1 ? <button className="text-link" disabled={pending} onClick={() => change(row.campaignId, row.variantId, row.campaignRevision, row.quantity - 1)}>Giảm {row.label}</button> : null}
      <button className="text-link" disabled={pending} onClick={() => change(row.campaignId, row.variantId, row.campaignRevision, 0)}>Bỏ {row.label}</button>
    </div>)}
    {model.campaigns.map((campaign, index) => {
      const product = campaign.products.find((row) => row.productId === products[campaign.campaignId]);
      return <fieldset className="mt-5 border-t border-black/15 pt-4" disabled={pending} key={campaign.campaignId}>
        <legend className="font-semibold">Quà tặng theo giỏ hàng {index + 1}</legend>
        <p className="text-sm leading-6">Đạt {campaign.earned} suất · Được nhận {campaign.entitled} · Đã chọn {campaign.selected} · Chưa chọn {campaign.unclaimed}</p>
        {campaign.shortageText ? <p className="mt-2 text-sm">{campaign.shortageText} Bạn có thể chọn hàng còn hoặc để trống.</p> : null}
        {!campaign.allowDuplicateGifts ? <p className="mt-2 text-sm">Mỗi sản phẩm được chọn tối đa 1 chiếc quà, kể cả khác màu hoặc kích cỡ.</p> : null}
        {campaign.shortfallText ? <p className="mt-2 text-sm">{campaign.shortfallText}</p> : null}
        {campaign.entitled === 0 ? null : <>
          <label className="mt-4 block text-sm" htmlFor={`gift-product-${index}`}>Sản phẩm quà</label>
          <select className="mt-2 w-full border border-black/30 p-3" id={`gift-product-${index}`} value={products[campaign.campaignId] ?? ""} onChange={(event) => setProducts({ ...products, [campaign.campaignId]: event.target.value })}>
            <option value="">Chọn sản phẩm quà</option>
            {campaign.products.map((p) => <option key={p.productId} value={p.productId}>{p.name}</option>)}
          </select>
          {product ? <div className="mt-4 grid gap-3">{product.options.map((option) => {
            const selected = model.selections.find((row) => row.campaignId === campaign.campaignId && row.variantId === option.variantId)?.quantity ?? 0;
            const productChosen = model.selections.some((row) => row.campaignId === campaign.campaignId && product.options.some((o) => o.variantId === row.variantId));
            const stockChosen = model.selections.filter((row) => row.variantId === option.variantId).reduce((sum, row) => sum + row.quantity, 0);
            return <div className="flex flex-wrap items-center justify-between gap-3" key={option.variantId}>
              <p className="text-sm">{option.label} · Còn {option.stock}</p>
              <button className="btn btn--secondary" disabled={pending || option.stock <= stockChosen || campaign.selected >= campaign.entitled || model.invalid || (!campaign.allowDuplicateGifts && productChosen)} onClick={() => change(campaign.campaignId, option.variantId, campaign.revision, selected + 1)}>Chọn {option.label}</button>
            </div>;
          })}</div> : null}
        </>}
      </fieldset>;
    })}
    <p className="mt-4 text-sm" role="status" aria-live="polite">{pending ? "Đang lưu lựa chọn…" : message}</p>
  </section>;
}
