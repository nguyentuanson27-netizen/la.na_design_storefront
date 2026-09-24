import Image from "next/image";
import Link from "next/link";

export type ProductPancakeSourceVariant = {
  id: string;
  sku: string | null;
  color: string | null;
  size: string | null;
  pancakeRetailPrice: number | null;
  pancakeRetailPriceAfterDiscount: number | null;
  stock: number;
  isActive: boolean;
};

export type ProductPancakeCompositeParent = {
  id: string;
  sku: string | null;
  color: string | null;
  size: string | null;
  components: Array<{
    quantity: number;
    stock: number;
    variant: {
      id: string;
      sku: string | null;
      color: string | null;
      size: string | null;
      isPresent: boolean;
      isActive: boolean;
      product: {
        id: string;
        name: string;
        slug: string;
        isPresent: boolean;
        isActive: boolean;
      };
    };
  }>;
};

type ProductPancakeSourceProps = {
  productName: string;
  sourceDescription: string | null;
  imageUrls: string[];
  variants: ProductPancakeSourceVariant[];
  compositeParents: ProductPancakeCompositeParent[];
};

function formatVnd(amount: number | null | undefined): string {
  if (typeof amount !== "number" || Number.isNaN(amount)) return "—";
  return new Intl.NumberFormat("vi-VN").format(amount) + " ₫";
}

export function ProductPancakeSource({
  productName,
  sourceDescription,
  imageUrls,
  variants,
  compositeParents,
}: ProductPancakeSourceProps) {
  const prices = variants
    .map((variant) => variant.pancakeRetailPriceAfterDiscount ?? variant.pancakeRetailPrice)
    .filter((price): price is number => typeof price === "number" && !Number.isNaN(price));
  const minPrice = prices.length > 0 ? Math.min(...prices) : null;
  const maxPrice = prices.length > 0 ? Math.max(...prices) : null;
  const priceDisplay =
    minPrice !== null && maxPrice !== null
      ? minPrice === maxPrice
        ? formatVnd(minPrice)
        : `${formatVnd(minPrice)} – ${formatVnd(maxPrice)}`
      : "Chưa có giá";
  const totalStock = variants.reduce((sum, variant) => sum + variant.stock, 0);

  return (
    <details className="mt-8 border border-black/20 bg-black/[0.02]">
      <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-4 p-5 focus-visible:outline-2 focus-visible:outline-offset-4 md:p-6">
        <span>
          <span className="eyebrow block">Nguồn Pancake · chỉ đọc</span>
          <span className="mt-1 block font-display text-2xl tracking-[-0.03em] md:text-3xl">
            Dữ liệu nguồn & composite
          </span>
        </span>
        <span className="shrink-0 text-xs font-semibold uppercase tracking-[0.12em] text-black/60">
          Mở chi tiết nguồn
        </span>
      </summary>

      <div className="border-t border-black/15 p-6 md:p-8">
        <section aria-labelledby="source-description-heading">
          <div className="flex flex-col justify-between gap-4 border-b border-black/15 pb-6 md:flex-row md:items-center">
            <div>
              <p className="eyebrow">Nguồn mô tả</p>
              <h2 id="source-description-heading" className="mt-1 font-display text-3xl tracking-[-0.03em]">
                Nguồn mô tả từ Pancake
              </h2>
            </div>
            <div className="flex flex-wrap gap-4 text-xs font-semibold uppercase tracking-[0.12em]">
              <div className="border border-black/20 bg-white px-4 py-2">
                <span className="text-black/70">Giá bán: </span>
                <span className="text-black">{priceDisplay}</span>
              </div>
              <div className="border border-black/20 bg-white px-4 py-2">
                <span className="text-black/70">Biến thể: </span>
                <span className="text-black">{variants.length} phân loại</span>
              </div>
              <div className="border border-black/20 bg-white px-4 py-2">
                <span className="text-black/70">Tổng tồn kho: </span>
                <span className="text-black">{totalStock} cái</span>
              </div>
            </div>
          </div>

          <div className="mt-6">
            {sourceDescription ? (
              <p className="whitespace-pre-wrap text-sm leading-7 text-black/80">{sourceDescription}</p>
            ) : (
              <p className="text-sm leading-7 text-black/70">Chưa có mô tả nguồn từ Pancake.</p>
            )}
            <p className="mt-3 max-w-3xl text-xs leading-5 text-black/70">
              Dữ liệu này chỉ dùng làm ngữ cảnh đối chiếu. Đồng bộ Pancake không tự xuất bản và không ghi đè nội dung editorial hoặc SEO do website sở hữu.
            </p>
          </div>

          <div className="mt-6">
            <h3 className="text-xs font-semibold uppercase tracking-[0.13em] text-black/80">
              Hình ảnh sản phẩm ({imageUrls.length} ảnh)
            </h3>
            {imageUrls.length > 0 ? (
              <div className="mt-3 flex flex-wrap gap-4">
                {imageUrls.map((url, index) => (
                  <div
                    key={url}
                    className="relative aspect-[3/4] w-24 overflow-hidden border border-black/20 bg-[var(--stone)] md:w-32"
                  >
                    <Image
                      src={url}
                      alt={`${productName} ảnh ${index + 1}`}
                      fill
                      sizes="128px"
                      className="object-cover"
                      unoptimized
                    />
                  </div>
                ))}
              </div>
            ) : (
              <p className="mt-2 text-sm text-black/70 italic">
                Chưa có hình ảnh nào được tải lên Pancake cho sản phẩm này.
              </p>
            )}
          </div>

          <div className="mt-8">
            <h3 className="text-xs font-semibold uppercase tracking-[0.13em] text-black/80">
              Chi tiết các biến thể (Màu / Size / Giá / Kho)
            </h3>
            {variants.length > 0 ? (
              <div
                aria-label="Bảng biến thể sản phẩm, cuộn ngang khi cần"
                className="mt-3 max-w-full overflow-x-auto"
                tabIndex={0}
              >
                <table className="w-full min-w-[48rem] text-left text-xs">
                  <thead>
                    <tr className="border-b border-black/20 bg-black/5 uppercase tracking-[0.1em] text-black/80">
                      <th scope="col" className="px-3 py-2.5">SKU</th>
                      <th scope="col" className="px-3 py-2.5">Màu sắc</th>
                      <th scope="col" className="px-3 py-2.5">Kích cỡ</th>
                      <th scope="col" className="px-3 py-2.5">Giá niêm yết</th>
                      <th scope="col" className="px-3 py-2.5">Giá sau giảm</th>
                      <th scope="col" className="px-3 py-2.5">Tồn kho</th>
                      <th scope="col" className="px-3 py-2.5">Trạng thái</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-black/10">
                    {variants.map((variant) => (
                      <tr key={variant.id} className="hover:bg-black/[0.02]">
                        <td className="px-3 py-2.5 font-mono">{variant.sku || "—"}</td>
                        <td className="px-3 py-2.5 font-medium">{variant.color || "—"}</td>
                        <td className="px-3 py-2.5 font-medium">{variant.size || "—"}</td>
                        <td className="px-3 py-2.5">{formatVnd(variant.pancakeRetailPrice)}</td>
                        <td className="px-3 py-2.5 font-medium text-black">
                          {variant.pancakeRetailPriceAfterDiscount
                            ? formatVnd(variant.pancakeRetailPriceAfterDiscount)
                            : formatVnd(variant.pancakeRetailPrice)}
                        </td>
                        <td className="px-3 py-2.5 font-semibold">
                          {variant.stock > 0 ? (
                            <span className="text-emerald-800">{variant.stock}</span>
                          ) : (
                            <span className="text-rose-700">Hết hàng</span>
                          )}
                        </td>
                        <td className="px-3 py-2.5">
                          <span
                            className={`inline-block rounded-full px-2 py-0.5 text-[0.65rem] font-semibold uppercase tracking-wider ${
                              variant.isActive
                                ? "bg-emerald-100 text-emerald-900"
                                : "bg-black/10 text-black/80"
                            }`}
                          >
                            {variant.isActive ? "Hoạt động" : "Tắt"}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="mt-2 text-sm text-black/70 italic">Chưa có biến thể nào.</p>
            )}
          </div>
        </section>

        {compositeParents.length > 0 ? (
          <section
            aria-labelledby="composite-components-heading"
            className="mt-8 border-t border-black/20 pt-8"
          >
            <p className="eyebrow">Pancake composite</p>
            <h2 id="composite-components-heading" className="mt-1 font-display text-3xl tracking-[-0.03em]">
              Thành phần sản phẩm / Sản phẩm con
            </h2>
            <p className="mt-3 max-w-3xl text-sm leading-6 text-black/70">
              Quan hệ dưới đây đọc trực tiếp từ composite mirror đã đồng bộ, không suy luận theo tên,
              SKU hay category. Chỉ để kiểm tra; chỉnh sửa cấu thành vẫn thuộc Pancake.
            </p>

            <div className="mt-6 space-y-8">
              {compositeParents.map((parent) => (
                <div key={parent.id}>
                  <h3 className="text-xs font-semibold uppercase tracking-[0.13em] text-black/80">
                    Biến thể cha: {parent.sku || "—"}
                    {parent.color || parent.size
                      ? ` · ${[parent.color, parent.size].filter(Boolean).join(" / ")}`
                      : ""}
                  </h3>
                  <div className="mt-3 max-w-full overflow-x-auto">
                    <table className="w-full min-w-[48rem] text-left text-xs">
                      <caption className="sr-only">
                        Sản phẩm con cấu thành biến thể {parent.sku || parent.id}
                      </caption>
                      <thead>
                        <tr className="border-b border-black/20 bg-black/5 uppercase tracking-[0.1em] text-black/80">
                          <th className="px-3 py-2.5" scope="col">Sản phẩm con</th>
                          <th className="px-3 py-2.5" scope="col">SKU</th>
                          <th className="px-3 py-2.5" scope="col">Màu / Size</th>
                          <th className="px-3 py-2.5" scope="col">Số lượng cấu thành</th>
                          <th className="px-3 py-2.5" scope="col">Tồn kho</th>
                          <th className="px-3 py-2.5" scope="col">Trạng thái</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-black/10">
                        {parent.components.map((component) => {
                          const child = component.variant;
                          const statusLabel = !child.product.isPresent
                            ? "Sản phẩm con không còn đồng bộ"
                            : !child.isPresent
                              ? "Biến thể không còn đồng bộ"
                              : child.isActive
                                ? "Đã kích hoạt biến thể"
                                : "Chưa kích hoạt biến thể";
                          const variantReady = child.product.isPresent && child.isPresent && child.isActive;

                          return (
                            <tr className="hover:bg-black/[0.02]" key={`${parent.id}-${child.id}`}>
                              <td className="px-3 py-2.5">
                                <Link
                                  className="font-medium underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-4"
                                  href={`/admin/products/${child.product.id}`}
                                >
                                  {child.product.name}
                                </Link>
                                <span className="mt-0.5 block text-black/60">/{child.product.slug}</span>
                              </td>
                              <td className="px-3 py-2.5 font-mono">{child.sku || "—"}</td>
                              <td className="px-3 py-2.5 font-medium">
                                {[child.color, child.size].filter(Boolean).join(" / ") || "—"}
                              </td>
                              <td className="px-3 py-2.5 font-semibold">×{component.quantity}</td>
                              <td className="px-3 py-2.5 font-semibold">
                                {component.stock > 0 ? (
                                  <span className="text-emerald-800">{component.stock}</span>
                                ) : (
                                  <span className="text-rose-700">Hết hàng</span>
                                )}
                              </td>
                              <td className="px-3 py-2.5">
                                <span
                                  className={`inline-block rounded-full px-2 py-0.5 text-[0.65rem] font-semibold uppercase tracking-wider ${
                                    variantReady
                                      ? "bg-emerald-100 text-emerald-900"
                                      : "bg-black/10 text-black/80"
                                  }`}
                                >
                                  {statusLabel}
                                </span>
                                <span className="mt-1 block text-[0.65rem] text-black/55">
                                  Catalog riêng: {child.product.isActive ? "đang hoạt động" : "tắt"}
                                </span>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              ))}
            </div>
          </section>
        ) : null}
      </div>
    </details>
  );
}
