import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { requireCurrentAdmin } from "@/auth/current-admin";
import { BRAND } from "@/brand";
import {
  createProductSlugAdminService,
  createProductSlugRepository,
  PRODUCT_SLUG_LIMITS,
} from "@/commerce/product-slug";
import { prisma } from "@/db/prisma";

const repository = createProductSlugRepository(prisma);
const adminService = createProductSlugAdminService({ changeSlug: repository.changeSlug });

const inputClassName =
  "w-full border-b border-black/30 bg-transparent px-0 py-3 text-base outline-none transition-colors placeholder:text-black/35 focus-visible:border-black focus-visible:outline-2 focus-visible:outline-offset-4";

const PRODUCT_SLUG_INPUT_ID = "product-slug-input";
const PRODUCT_SLUG_DESCRIPTION_ID = "product-slug-current-url";

type ProductSlugEditorProps = {
  productId: string;
  currentSlug: string;
  editorPath: string;
  saved: boolean;
  error: "invalid" | "unavailable" | null;
};

export function ProductSlugEditor({
  productId,
  currentSlug,
  editorPath,
  saved,
  error,
}: ProductSlugEditorProps) {
  async function saveProductSlug(formData: FormData) {
    "use server";

    const adminSession = await requireCurrentAdmin();
    const result = await adminService.update(adminSession, {
      productId,
      slug: formData.get("slug"),
    });

    if (!result.ok) {
      if (result.reason === "PRODUCT_NOT_FOUND") redirect("/admin");
      const reason = result.reason === "SLUG_UNAVAILABLE" ? "unavailable" : "invalid";
      redirect(`${editorPath}?slugError=${reason}`);
    }

    revalidatePath(editorPath);
    revalidatePath("/admin");
    revalidatePath("/shop");
    revalidatePath(`/shop/${result.previousSlug}`);
    revalidatePath(`/shop/${result.slug}`);
    redirect(`${editorPath}?slugSaved=1`);
  }

  return (
    <section
      aria-labelledby="product-slug-heading"
      className="mt-8 border border-black/20 p-6 md:p-8"
    >
      <p className="eyebrow">Website URL · sở hữu bởi {BRAND.identity.name}</p>
      <h2 id="product-slug-heading" className="mt-2 font-serif text-3xl tracking-[-0.03em]">
        Quản lý URL sản phẩm
      </h2>
      <p className="mt-4 max-w-3xl text-xs leading-5 text-black/55">
        Pancake chỉ cung cấp tên làm dữ liệu bootstrap ban đầu. Đồng bộ tên sau đó không tự đổi URL. Mỗi thay đổi slug explicit sẽ giữ slug cũ trong lịch sử URL và slug lịch sử không được tái sử dụng.
      </p>

      {saved ? (
        <p className="mt-5 border-l-2 border-black pl-4 text-sm font-semibold" role="status">
          Đã lưu slug sản phẩm.
        </p>
      ) : null}
      {error === "invalid" ? (
        <p className="mt-5 border-l-2 border-black pl-4 text-sm font-semibold" role="alert">
          Slug không hợp lệ. Hãy dùng tên có chữ hoặc số; hệ thống sẽ chuẩn hóa thành chữ thường và dấu gạch ngang.
        </p>
      ) : null}
      {error === "unavailable" ? (
        <p className="mt-5 border-l-2 border-black pl-4 text-sm font-semibold" role="alert">
          Slug này đã thuộc URL hiện tại hoặc lịch sử của một sản phẩm khác.
        </p>
      ) : null}

      <form action={saveProductSlug} className="mt-6 grid gap-5 md:grid-cols-[1fr_auto] md:items-end">
        <div className="block">
          <label
            className="text-xs font-semibold uppercase tracking-[0.13em]"
            htmlFor={PRODUCT_SLUG_INPUT_ID}
          >
            Slug sản phẩm
          </label>
          <input
            aria-describedby={PRODUCT_SLUG_DESCRIPTION_ID}
            className={inputClassName}
            defaultValue={currentSlug}
            id={PRODUCT_SLUG_INPUT_ID}
            maxLength={PRODUCT_SLUG_LIMITS.rawInput}
            name="slug"
            type="text"
          />
          <p
            className="mt-3 break-all text-xs leading-5 text-black/55"
            id={PRODUCT_SLUG_DESCRIPTION_ID}
          >
            URL hiện tại: /shop/{currentSlug}
          </p>
        </div>
        <button
          className="inline-flex min-h-11 items-center justify-center border border-black px-5 py-3 text-xs font-semibold uppercase tracking-[0.14em] transition-colors hover:bg-black hover:text-white focus-visible:outline-2 focus-visible:outline-offset-4"
          type="submit"
        >
          Lưu slug
        </button>
      </form>
    </section>
  );
}
