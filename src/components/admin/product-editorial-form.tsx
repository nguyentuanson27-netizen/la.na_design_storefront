import Link from "next/link";

import { APPROVED_SIZE_GUIDES, isApprovedSizeGuideId } from "@/brand";
import { PRODUCT_CONTENT_LIMITS } from "@/commerce/product-content-admin";
import { SEO_LENGTH_GUIDANCE } from "@/commerce/seo-length-guidance";
import { SeoLengthField } from "./seo-length-field";

const inputClassName =
  "w-full border-b border-black/30 bg-transparent px-0 py-3 text-base outline-none transition-colors placeholder:text-black/35 focus-visible:border-black focus-visible:outline-2 focus-visible:outline-offset-4";
const textareaClassName = `${inputClassName} min-h-36 resize-y leading-7`;

export type ProductEditorCollectionChoice = {
  slug: string;
  title: string;
  isPublished: boolean;
  checked: boolean;
  missing: boolean;
};

type ProductEditorContent = {
  status: "DRAFT" | "REVIEWED" | "PUBLISHED";
  editorialDescription: string | null;
  careInstructions: string | null;
  sizeGuide: string | null;
  seoTitle: string | null;
  seoDescription: string | null;
};

type ProductEditorialFormProps = {
  action: (formData: FormData) => void | Promise<void>;
  content: ProductEditorContent | null;
  collectionChoices: ProductEditorCollectionChoice[];
  /** Published products already holding this product's `(seoTitle, seoDescription)` pair. */
  seoPairConflictSlugs?: readonly string[];
};

export function ProductEditorialForm({
  action,
  content,
  collectionChoices,
  seoPairConflictSlugs = [],
}: ProductEditorialFormProps) {
  return (
    <form action={action} className="mt-8 grid gap-12 lg:grid-cols-[1.35fr_0.65fr]">
      <div className="space-y-10">
        <section aria-labelledby="editorial-heading">
          <p className="eyebrow">Storefront</p>
          <h2 id="editorial-heading" className="mt-2 font-display text-3xl tracking-[-0.03em]">
            Nội dung editorial
          </h2>
          <div className="mt-8 space-y-8">
            <label className="block">
              <span className="text-xs font-semibold uppercase tracking-[0.13em]">Mô tả biên tập</span>
              <textarea
                className={textareaClassName}
                defaultValue={content?.editorialDescription ?? ""}
                maxLength={PRODUCT_CONTENT_LIMITS.editorialField}
                name="editorialDescription"
                rows={7}
              />
            </label>

            <label className="block">
              <span className="text-xs font-semibold uppercase tracking-[0.13em]">Hướng dẫn bảo quản</span>
              <textarea
                className={textareaClassName}
                defaultValue={content?.careInstructions ?? ""}
                maxLength={PRODUCT_CONTENT_LIMITS.editorialField}
                name="careInstructions"
                rows={5}
              />
            </label>

            <label className="block">
              <span className="text-xs font-semibold uppercase tracking-[0.13em]">Bảng size</span>
              <select
                className={inputClassName}
                defaultValue={content?.sizeGuide ?? ""}
                name="sizeGuide"
              >
                <option value="">Chưa chọn bảng size</option>
                {content?.sizeGuide && !isApprovedSizeGuideId(content.sizeGuide) ? (
                  <option disabled value={content.sizeGuide}>
                    [Không hợp lệ] {content.sizeGuide} — vui lòng chọn lại
                  </option>
                ) : null}
                {APPROVED_SIZE_GUIDES.map((guide) => (
                  <option key={guide.id} value={guide.id}>
                    {guide.title} ({guide.id})
                  </option>
                ))}
              </select>
              <span className="mt-3 block text-xs leading-5 text-black/55">
                Chọn bảng size đã được phê duyệt cho sản phẩm. Để trống nếu chưa gán bảng size.
              </span>
            </label>
          </div>
        </section>
      </div>

      <aside className="space-y-10 lg:border-l lg:border-black/20 lg:pl-8">
        <section aria-labelledby="publication-heading">
          <p className="eyebrow">Publication</p>
          <h2 id="publication-heading" className="mt-2 font-display text-3xl tracking-[-0.03em]">
            Trạng thái
          </h2>
          <label className="mt-8 block">
            <span className="text-xs font-semibold uppercase tracking-[0.13em]">
              Trạng thái xuất bản
            </span>
            <select
              className={inputClassName}
              defaultValue={content?.status ?? "DRAFT"}
              name="status"
            >
              <option value="DRAFT">DRAFT — Bản nháp</option>
              <option value="REVIEWED">REVIEWED — Đã duyệt nội bộ</option>
              <option value="PUBLISHED">PUBLISHED — Công khai</option>
            </select>
            <span className="mt-3 block text-xs leading-5 text-black/55">
              Chỉ PUBLISHED được đưa các trường editorial và SEO ra storefront. DRAFT và REVIEWED vẫn là nội dung nội bộ.
            </span>
          </label>
        </section>

        <section aria-labelledby="collections-heading" className="border-t border-black/20 pt-10">
          <p className="eyebrow">Discovery</p>
          <h2 id="collections-heading" className="mt-2 font-display text-3xl tracking-[-0.03em]">
            Bộ sưu tập
          </h2>
          {collectionChoices.length === 0 ? (
            <p className="mt-8 max-w-2xl text-sm leading-6 text-black/65">
              Chưa có collection nào để gán.{" "}
              <Link
                className="underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-4"
                href="/admin/collections"
              >
                Tạo collection
              </Link>{" "}
              trước, sau đó quay lại gán sản phẩm.
            </p>
          ) : (
            <fieldset className="mt-8">
              <legend className="text-xs font-semibold uppercase tracking-[0.13em]">
                Thuộc collection
              </legend>
              <div className="mt-4 grid gap-x-8 gap-y-1 sm:grid-cols-2 lg:grid-cols-3">
                {collectionChoices.map((choice) => (
                  <label
                    className="flex min-h-11 items-center gap-3 border-b border-black/10 py-2 text-sm"
                    key={choice.slug}
                  >
                    <input
                      className="size-5 shrink-0 accent-black focus-visible:outline-2 focus-visible:outline-offset-4"
                      defaultChecked={choice.checked}
                      name="collectionSlugs"
                      type="checkbox"
                      value={choice.slug}
                    />
                    <span className="min-w-0">
                      <span className="block truncate">{choice.title}</span>
                      <span className="block truncate text-xs text-black/50">
                        /{choice.slug}
                        {choice.isPublished ? "" : " · draft"}
                        {choice.missing ? " · không còn định nghĩa" : ""}
                      </span>
                    </span>
                  </label>
                ))}
              </div>
              <p className="mt-4 max-w-2xl text-xs leading-5 text-black/55">
                Tối đa {PRODUCT_CONTENT_LIMITS.collectionCount} collection. Membership do website
                quản lý; bỏ chọn không xóa collection, chỉ gỡ sản phẩm khỏi collection đó.
              </p>
            </fieldset>
          )}
        </section>

        <section aria-labelledby="seo-heading" className="border-t border-black/20 pt-10">
          <p className="eyebrow">Tìm kiếm</p>
          <h2 id="seo-heading" className="mt-2 font-display text-3xl tracking-[-0.03em]">
            SEO
          </h2>
          <div className="mt-8 space-y-8">
            <SeoLengthField
              className={inputClassName}
              defaultValue={content?.seoTitle ?? ""}
              label="SEO title"
              maxLength={PRODUCT_CONTENT_LIMITS.seoTitle}
              name="seoTitle"
              recommendedLength={SEO_LENGTH_GUIDANCE.seoTitle}
            />

            <SeoLengthField
              className={textareaClassName}
              defaultValue={content?.seoDescription ?? ""}
              label="SEO description"
              maxLength={PRODUCT_CONTENT_LIMITS.seoDescription}
              multiline
              name="seoDescription"
              recommendedLength={SEO_LENGTH_GUIDANCE.seoDescription}
              rows={5}
            />

            {/*
              B5: a collision is a warning here, never a block. A draft is allowed to hold copy a
              published product already owns; only the move to PUBLISHED is refused, and that is
              enforced server-side. This is rendered from persisted state on every load rather than
              announced live, so it does not interrupt typing.
            */}
            {seoPairConflictSlugs.length > 0 ? (
              <p className="border-l-2 border-black pl-4 text-sm leading-6" data-seo-pair-warning>
                <span className="font-semibold">Cảnh báo trùng SEO.</span> Cặp SEO title +
                description hiện tại đã thuộc về sản phẩm đã publish:{" "}
                {seoPairConflictSlugs.map((slug) => `/${slug}`).join(", ")}. Vẫn lưu được bản nháp,
                nhưng không thể chuyển sang PUBLISHED cho đến khi sửa một trong hai trường.
              </p>
            ) : null}
          </div>
        </section>

        <div className="border-t border-black/20 pt-8">
          <p className="text-sm leading-6 text-black/65">
            Các trường để trống sẽ xóa nội dung biên tập tương ứng. Màn hình này không sửa giá, tồn kho, SKU hay trạng thái vận hành từ Pancake.
          </p>
          <button
            className="mt-6 inline-flex min-h-11 w-full items-center justify-center border border-black px-5 py-3 text-xs font-semibold uppercase tracking-[0.14em] transition-colors hover:bg-black hover:text-white focus-visible:outline-2 focus-visible:outline-offset-4"
            type="submit"
          >
            Lưu nội dung
          </button>
        </div>
      </aside>
    </form>
  );
}
