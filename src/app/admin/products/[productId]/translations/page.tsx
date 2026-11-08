import type { Metadata } from "next";
import Link from "next/link";
import { revalidatePath } from "next/cache";
import { notFound, redirect } from "next/navigation";

import { requireCurrentAdmin, requireCurrentAdminPage } from "@/auth/current-admin";
import {
  PRODUCT_TRANSLATION_LIMITS,
  parseProductTranslationInput,
  type ProductTranslationInput,
} from "@/commerce/product-translation";
import { createProductTranslationRepository } from "@/commerce/product-translation-repository";
import { prisma } from "@/db/prisma";

export const metadata: Metadata = {
  title: "Bản dịch tiếng Anh",
};

const repository = createProductTranslationRepository(prisma);

const inputClassName =
  "w-full border-b border-black/30 bg-transparent px-0 py-3 text-base outline-none transition-colors placeholder:text-black/35 focus-visible:border-black focus-visible:outline-2 focus-visible:outline-offset-4";
const textareaClassName = `${inputClassName} min-h-28 resize-y leading-7`;
const labelClassName = "text-xs font-semibold uppercase tracking-[0.13em]";
const hintClassName = "mt-2 block text-xs leading-5 text-black/55";
const primaryButton =
  "min-h-11 bg-black px-6 text-xs font-semibold uppercase tracking-[0.14em] text-white focus-visible:outline-2 focus-visible:outline-offset-4";

const FIELD_MESSAGES: Record<keyof ProductTranslationInput, string> = {
  name: `Tên dài quá ${PRODUCT_TRANSLATION_LIMITS.name} ký tự.`,
  editorialDescription: `Mô tả dài quá ${PRODUCT_TRANSLATION_LIMITS.editorialField} ký tự.`,
  material: `Chất liệu dài quá ${PRODUCT_TRANSLATION_LIMITS.editorialField} ký tự.`,
  craftDetails: `Tối đa ${PRODUCT_TRANSLATION_LIMITS.craftDetailCount} dòng chi tiết, mỗi dòng không quá ${PRODUCT_TRANSLATION_LIMITS.craftDetail} ký tự.`,
  careInstructions: `Hướng dẫn bảo quản dài quá ${PRODUCT_TRANSLATION_LIMITS.editorialField} ký tự.`,
  seoTitle: `Tiêu đề SEO dài quá ${PRODUCT_TRANSLATION_LIMITS.seoTitle} ký tự.`,
  seoDescription: `Mô tả SEO dài quá ${PRODUCT_TRANSLATION_LIMITS.seoDescription} ký tự.`,
};

function queryValue(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : value?.[0];
}

type AdminProductTranslationsPageProps = {
  params: Promise<{ productId: string }>;
  searchParams: Promise<{ saved?: string | string[]; error?: string | string[] }>;
};

/**
 * The English side of a product: its name and editorial copy, entered by hand.
 *
 * A field left empty falls back to the Vietnamese on the English storefront, so a product can be
 * translated a piece at a time. The Vietnamese stays where it is (the name belongs to the Pancake
 * sync; the copy to the editorial form) and is shown beside each field for reference.
 */
export default async function AdminProductTranslationsPage({
  params,
  searchParams,
}: AdminProductTranslationsPageProps) {
  const { productId } = await params;
  if (productId.length === 0 || productId.length > 64 || productId !== productId.trim()) notFound();

  await requireCurrentAdminPage();
  const product = await prisma.productMirror.findUnique({
    where: { id: productId },
    select: {
      id: true,
      name: true,
      slug: true,
      content: {
        select: {
          editorialDescription: true,
          material: true,
          craftDetails: true,
          careInstructions: true,
          seoTitle: true,
          seoDescription: true,
        },
      },
    },
  });
  if (!product) notFound();

  const persistedProductId = product.id;
  const persistedProductSlug = product.slug;
  const pagePath = `/admin/products/${persistedProductId}/translations`;

  async function saveTranslation(formData: FormData) {
    "use server";

    await requireCurrentAdmin();
    const field = (name: keyof ProductTranslationInput): unknown => formData.get(name);
    const parsed = parseProductTranslationInput({
      name: field("name"),
      editorialDescription: field("editorialDescription"),
      material: field("material"),
      craftDetails: field("craftDetails"),
      careInstructions: field("careInstructions"),
      seoTitle: field("seoTitle"),
      seoDescription: field("seoDescription"),
    });
    if (!parsed.ok) redirect(`${pagePath}?error=${parsed.field}`);

    await repository.save(persistedProductId, "en", parsed.value);
    revalidatePath(pagePath);
    revalidatePath("/en/shop/[slug]", "page");
    redirect(`${pagePath}?saved=1`);
  }

  const [current, query] = await Promise.all([repository.read(persistedProductId, "en"), searchParams]);
  const saved = queryValue(query.saved) === "1";
  const errorField = queryValue(query.error) as keyof ProductTranslationInput | undefined;
  const errorMessage = errorField && errorField in FIELD_MESSAGES ? FIELD_MESSAGES[errorField] : null;
  const source = product.content;

  function reference(text: string | null | undefined) {
    return text && text.trim().length > 0 ? (
      <span className={hintClassName}>
        <span className="font-semibold">Tiếng Việt:</span> <span className="whitespace-pre-line">{text}</span>
      </span>
    ) : null;
  }

  return (
    <div className="mx-auto max-w-5xl">
      <div className="border-b border-black/20 pb-8">
        <Link
          className="text-xs font-semibold uppercase tracking-[0.14em] text-black/60 underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-4"
          href={`/admin/products/${persistedProductId}`}
        >
          ← Biên tập sản phẩm
        </Link>
        <p className="eyebrow mt-8">Bản dịch tiếng Anh</p>
        <h1 className="mt-3 max-w-4xl font-display text-4xl leading-[1] tracking-[-0.04em] md:text-6xl">
          {product.name}
        </h1>
        <p className="mt-6 max-w-2xl text-sm leading-6 text-black/70">
          Nội dung tiếng Anh hiển thị ở <span className="font-mono">/en/shop/{persistedProductSlug}</span>, danh sách
          sản phẩm và giỏ hàng bản tiếng Anh. Ô nào để trống sẽ dùng lại nội dung tiếng Việt, nên có thể dịch dần từng
          phần. Tên sản phẩm gốc vẫn do Pancake đồng bộ.
        </p>
        <p className="mt-3 text-xs text-black/55">
          <Link className="underline underline-offset-4" href={`/en/shop/${persistedProductSlug}`} target="_blank">
            Xem trang sản phẩm tiếng Anh
          </Link>
        </p>
      </div>

      <div className="mt-6 min-h-6" role={errorMessage ? "alert" : "status"} aria-atomic="true">
        {saved ? <p className="border-l-2 border-black pl-4 text-sm font-semibold">Đã lưu.</p> : null}
        {errorMessage ? <p className="border-l-2 border-black pl-4 text-sm font-semibold">{errorMessage}</p> : null}
      </div>

      <form action={saveTranslation} className="mt-8 space-y-8">
        <label className="block">
          <span className={labelClassName}>Tên sản phẩm (English)</span>
          <input className={inputClassName} defaultValue={current.name ?? ""} maxLength={PRODUCT_TRANSLATION_LIMITS.name} name="name" />
          {reference(product.name)}
        </label>

        <label className="block">
          <span className={labelClassName}>Mô tả sản phẩm</span>
          <textarea className={textareaClassName} defaultValue={current.editorialDescription ?? ""} name="editorialDescription" rows={6} />
          {reference(source?.editorialDescription)}
        </label>

        <label className="block">
          <span className={labelClassName}>Chất liệu</span>
          <input className={inputClassName} defaultValue={current.material ?? ""} name="material" />
          {reference(source?.material)}
        </label>

        <label className="block">
          <span className={labelClassName}>Chi tiết thiết kế</span>
          <textarea className={textareaClassName} defaultValue={current.craftDetails.join("\n")} name="craftDetails" rows={4} />
          <span className={hintClassName}>Mỗi dòng một chi tiết. Để trống để dùng bản tiếng Việt.</span>
          {reference(source?.craftDetails.join("\n"))}
        </label>

        <label className="block">
          <span className={labelClassName}>Hướng dẫn bảo quản</span>
          <textarea className={textareaClassName} defaultValue={current.careInstructions ?? ""} name="careInstructions" rows={3} />
          {reference(source?.careInstructions)}
        </label>

        <div className="grid gap-8 md:grid-cols-2">
          <label className="block">
            <span className={labelClassName}>Tiêu đề SEO</span>
            <input className={inputClassName} defaultValue={current.seoTitle ?? ""} maxLength={PRODUCT_TRANSLATION_LIMITS.seoTitle} name="seoTitle" />
            {reference(source?.seoTitle)}
          </label>
          <label className="block">
            <span className={labelClassName}>Mô tả SEO</span>
            <textarea className={textareaClassName} defaultValue={current.seoDescription ?? ""} maxLength={PRODUCT_TRANSLATION_LIMITS.seoDescription} name="seoDescription" rows={4} />
            {reference(source?.seoDescription)}
          </label>
        </div>

        <button className={primaryButton} type="submit">
          Lưu bản dịch
        </button>
      </form>
    </div>
  );
}
