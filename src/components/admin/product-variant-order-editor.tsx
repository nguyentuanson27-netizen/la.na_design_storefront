import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { requireCurrentAdmin } from "@/auth/current-admin";
import { clearStorefrontRuntimeCaches } from "@/commerce/storefront-catalog-runtime";
import { createProductVariantOrderRepository } from "@/commerce/product-variant-order-repository";
import { normalizeVariantColor } from "@/commerce/product-variant-order";
import { prisma } from "@/db/prisma";

const repository = createProductVariantOrderRepository(prisma);

const ERROR_MESSAGES: Readonly<Record<string, string>> = {
  "product-not-found": "Không tìm thấy sản phẩm này. Chưa có thay đổi nào được lưu.",
  "unknown-color": "Có màu không thuộc sản phẩm này. Chưa có thay đổi nào được lưu.",
  "too-many": "Quá nhiều màu trong thứ tự. Chưa có thay đổi nào được lưu.",
  invalid: "Thứ tự phải là số nguyên từ 1, mỗi màu một ô. Chưa có thay đổi nào được lưu.",
};

type ProductVariantOrderEditorProps = {
  productId: string;
  editorPath: string;
  saved: boolean;
  error: string | undefined;
};

export async function ProductVariantOrderEditor({
  productId,
  editorPath,
  saved,
  error,
}: ProductVariantOrderEditorProps) {
  const { productColors, colors } = await repository.readEditorState(productId);
  const positionByColor = new Map(
    colors.map((color, index) => [normalizeVariantColor(color), index + 1]),
  );

  async function saveVariantColorOrder(formData: FormData) {
    "use server";

    await requireCurrentAdmin();
    const submittedColors = formData.getAll("color");
    const submittedPositions = formData.getAll("position");
    if (submittedColors.length !== submittedPositions.length) {
      redirect(`${editorPath}?variantOrderError=invalid`);
    }
    const result = await repository.save(
      productId,
      submittedColors.map((color, index) => ({ color, position: submittedPositions[index] })),
    );
    if (!result.ok) redirect(`${editorPath}?variantOrderError=${result.reason}`);

    revalidatePath(editorPath);
    clearStorefrontRuntimeCaches();
    revalidatePath("/shop");
    redirect(`${editorPath}?variantOrderSaved=1`);
  }

  async function clearVariantColorOrder() {
    "use server";

    await requireCurrentAdmin();
    await repository.clear(productId);

    revalidatePath(editorPath);
    clearStorefrontRuntimeCaches();
    revalidatePath("/shop");
    redirect(`${editorPath}?variantOrderSaved=1`);
  }

  return (
    <section
      aria-labelledby="product-variant-order-heading"
      className="mt-8 border border-black/20 p-6 md:p-8"
    >
      <p className="eyebrow">Hiển thị · thứ tự màu và ảnh</p>
      <h2
        id="product-variant-order-heading"
        className="mt-2 font-display text-3xl tracking-[-0.03em]"
      >
        Thứ tự màu và ảnh biến thể
      </h2>
      <p className="mt-4 max-w-3xl text-xs leading-5 text-black/55">
        Màu có số nhỏ nhất hiện đầu tiên: ảnh của màu đó đứng đầu bộ ảnh sản phẩm, làm ảnh đại diện
        ở các trang danh sách, đứng đầu bộ chọn màu (khách vẫn tự chọn màu). Màu để trống đi sau các màu
        đã đánh số, giữ thứ tự cũ. Trong mỗi màu, size luôn xếp S, M, L, XL. Đồng bộ Pancake không
        ghi đè thứ tự này. Nếu sản phẩm đã có ảnh đại diện riêng ở Pancake, ảnh đó vẫn đứng trước.
      </p>

      {saved ? (
        <p className="mt-5 border-l-2 border-black pl-4 text-sm font-semibold" role="status">
          Đã lưu thứ tự màu.
        </p>
      ) : null}
      {error ? (
        <p className="mt-5 border-l-2 border-black pl-4 text-sm font-semibold" role="alert">
          {ERROR_MESSAGES[error] ?? ERROR_MESSAGES.invalid}
        </p>
      ) : null}

      {productColors.length < 2 ? (
        <p className="mt-5 text-sm text-black/70">
          Sản phẩm này có {productColors.length} màu nên không cần sắp xếp.
        </p>
      ) : (
        <>
          <p className="mt-5 text-xs leading-5 text-black/55">
            {colors.length === 0
              ? "Trạng thái: chưa đặt (đang theo thứ tự đồng bộ)."
              : `Trạng thái: ${colors.join(" → ")}.`}
          </p>
          <form action={saveVariantColorOrder} className="mt-6 grid gap-4">
            {productColors.map((color) => {
              const inputId = `variant-order-${normalizeVariantColor(color).replace(/[^a-z0-9]+/gi, "-")}`;
              return (
                <div className="flex items-center gap-4" key={color}>
                  <input name="color" type="hidden" value={color} />
                  <input
                    className="w-20 border-b border-black/30 bg-transparent px-0 py-3 text-base outline-none transition-colors focus-visible:border-black focus-visible:outline-2 focus-visible:outline-offset-4"
                    defaultValue={positionByColor.get(normalizeVariantColor(color)) ?? ""}
                    id={inputId}
                    inputMode="numeric"
                    max={20}
                    min={1}
                    name="position"
                    step={1}
                    type="number"
                  />
                  <label className="text-sm font-semibold" htmlFor={inputId}>
                    {color}
                  </label>
                </div>
              );
            })}
            <div className="flex flex-wrap gap-3">
              <button
                className="inline-flex min-h-11 items-center justify-center border border-black px-5 py-3 text-xs font-semibold uppercase tracking-[0.14em] transition-colors hover:bg-black hover:text-white focus-visible:outline-2 focus-visible:outline-offset-4"
                type="submit"
              >
                Lưu thứ tự màu
              </button>
            </div>
          </form>
          <form action={clearVariantColorOrder} className="mt-4">
            <button
              className="inline-flex min-h-11 items-center justify-center border border-black/30 px-5 py-3 text-xs font-semibold uppercase tracking-[0.14em] transition-colors hover:border-black focus-visible:outline-2 focus-visible:outline-offset-4"
              type="submit"
            >
              Xóa thứ tự, quay lại mặc định
            </button>
          </form>
        </>
      )}
    </section>
  );
}
