import type { Metadata } from "next";
import Link from "next/link";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { requireCurrentAdmin, requireCurrentAdminPage } from "@/auth/current-admin";
import { createCollectionDefinitionAdminService } from "@/commerce/collection-definition-admin";
import {
  COLLECTION_DEFINITION_LIMITS,
  type CollectionDefinition,
} from "@/commerce/collection-definition";
import { createCollectionDefinitionRepository } from "@/commerce/collection-definition-repository";
import { createProductContentRepository } from "@/commerce/product-content-repository";
import { CollectionAdminStatus } from "@/components/admin/collection-admin-status";
import { prisma } from "@/db/prisma";

export const metadata: Metadata = {
  title: "Quản lý collections",
};

const repository = createCollectionDefinitionRepository(prisma);
const productRepository = createProductContentRepository(prisma);
const adminService = createCollectionDefinitionAdminService({
  createDefinition: repository.createDefinition,
  updateExistingDefinition: repository.updateExistingDefinition,
});
const HOMEPAGE_POSITIONS = Array.from(
  { length: COLLECTION_DEFINITION_LIMITS.homepagePosition },
  (_, index) => index + 1,
);

const inputClassName =
  "w-full border-b border-black/30 bg-transparent px-0 py-3 text-base outline-none transition-colors placeholder:text-black/35 focus-visible:border-black focus-visible:outline-2 focus-visible:outline-offset-4";
const textareaClassName = `${inputClassName} min-h-28 resize-y leading-7`;

function mutableCollectionInput(formData: FormData) {
  return {
    title: formData.get("title"),
    description: formData.get("description"),
    seoTitle: formData.get("seoTitle"),
    seoDescription: formData.get("seoDescription"),
    isPublished: formData.get("isPublished"),
    homepagePosition: formData.get("homepagePosition"),
    pancakeCategoryIds: formData.get("pancakeCategoryIds"),
  };
}

function finishCollectionMutation(result: { ok: boolean }) {
  if (!result.ok) {
    redirect("/admin/collections?error=invalid");
  }

  revalidatePath("/");
  revalidatePath("/admin/collections");
  revalidatePath("/admin");
  redirect("/admin/collections?saved=1");
}

async function createCollection(formData: FormData) {
  "use server";

  const adminSession = await requireCurrentAdmin();
  const result = await adminService.create(adminSession, {
    slug: formData.get("slug"),
    ...mutableCollectionInput(formData),
  });
  finishCollectionMutation(result);
}

async function updateCollection(targetSlug: string, formData: FormData) {
  "use server";

  const adminSession = await requireCurrentAdmin();
  const result = await adminService.update(
    adminSession,
    targetSlug,
    mutableCollectionInput(formData),
  );
  finishCollectionMutation(result);
}

function queryValue(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : value?.[0];
}

type CollectionFormProps = {
  definition?: CollectionDefinition;
  action: (formData: FormData) => Promise<void>;
};

function CollectionForm({ definition, action }: CollectionFormProps) {
  const existing = definition !== undefined;

  return (
    <form action={action} className="grid gap-8 lg:grid-cols-[1.2fr_0.8fr]">
      <div className="space-y-7">
        <label className="block">
          <span className="text-xs font-semibold uppercase tracking-[0.13em]">Slug</span>
          <input
            className={inputClassName}
            defaultValue={definition?.slug ?? ""}
            maxLength={COLLECTION_DEFINITION_LIMITS.slug}
            name="slug"
            placeholder="city-uniform"
            readOnly={existing}
            required
            type="text"
          />
          {existing ? (
            <span className="mt-2 block text-xs leading-5 text-black/55">
              Slug đã lưu được giữ ổn định để không làm hỏng product membership.
            </span>
          ) : null}
        </label>

        <label className="block">
          <span className="text-xs font-semibold uppercase tracking-[0.13em]">Tiêu đề</span>
          <input
            className={inputClassName}
            defaultValue={definition?.title ?? ""}
            maxLength={COLLECTION_DEFINITION_LIMITS.title}
            name="title"
            required
            type="text"
          />
        </label>

        <label className="block">
          <span className="text-xs font-semibold uppercase tracking-[0.13em]">Mô tả</span>
          <textarea
            className={textareaClassName}
            defaultValue={definition?.description ?? ""}
            maxLength={COLLECTION_DEFINITION_LIMITS.description}
            name="description"
            rows={5}
          />
          <span className="mt-2 block text-xs leading-5 text-black/55">
            Collection phải có mô tả hiển thị trước khi được publish.
          </span>
        </label>
      </div>

      <div className="space-y-7 lg:border-l lg:border-black/20 lg:pl-8">
        <label className="block">
          <span className="text-xs font-semibold uppercase tracking-[0.13em]">SEO title</span>
          <input
            className={inputClassName}
            defaultValue={definition?.seoTitle ?? ""}
            maxLength={COLLECTION_DEFINITION_LIMITS.seoTitle}
            name="seoTitle"
            type="text"
          />
        </label>

        <label className="block">
          <span className="text-xs font-semibold uppercase tracking-[0.13em]">SEO description</span>
          <textarea
            className={textareaClassName}
            defaultValue={definition?.seoDescription ?? ""}
            maxLength={COLLECTION_DEFINITION_LIMITS.seoDescription}
            name="seoDescription"
            rows={4}
          />
        </label>

        <label className="block">
          <span className="text-xs font-semibold uppercase tracking-[0.13em]">
            Pancake category IDs
          </span>
          <input
            className={inputClassName}
            defaultValue={definition?.pancakeCategoryIds.join(", ") ?? ""}
            maxLength={COLLECTION_DEFINITION_LIMITS.pancakeCategoryCount * 12}
            name="pancakeCategoryIds"
            placeholder="7, 42"
            type="text"
          />
          <span className="mt-2 block text-xs leading-5 text-black/55">
            Mapping tùy chọn theo ID; không tự publish collection và không thay website taxonomy.
          </span>
        </label>

        <label className="block">
          <span className="text-xs font-semibold uppercase tracking-[0.13em]">
            Vị trí trên trang chủ
          </span>
          <select
            className={inputClassName}
            defaultValue={definition?.homepagePosition?.toString() ?? ""}
            name="homepagePosition"
          >
            <option value="">Không hiển thị trên trang chủ</option>
            {HOMEPAGE_POSITIONS.map((position) => (
              <option key={position} value={position}>
                Vị trí {position}
              </option>
            ))}
          </select>
          <span className="mt-2 block text-xs leading-5 text-black/55">
            Chỉ collection đã publish và có vị trí 1–6 mới xuất hiện. Mỗi vị trí chỉ thuộc một collection.
          </span>
        </label>

        <label className="flex min-h-11 items-center gap-3 border-y border-black/20 py-3 text-sm font-semibold">
          <input
            className="size-5 accent-black focus-visible:outline-2 focus-visible:outline-offset-4"
            defaultChecked={definition?.isPublished ?? false}
            name="isPublished"
            type="checkbox"
          />
          Đã publish
        </label>

        <button
          className="inline-flex min-h-11 w-full items-center justify-center border border-black px-5 py-3 text-xs font-semibold uppercase tracking-[0.14em] transition-colors hover:bg-black hover:text-white focus-visible:outline-2 focus-visible:outline-offset-4"
          type="submit"
        >
          Lưu collection
        </button>
      </div>
    </form>
  );
}

type AdminCollectionsPageProps = {
  searchParams: Promise<{
    saved?: string | string[];
    error?: string | string[];
  }>;
};

export default async function AdminCollectionsPage({ searchParams }: AdminCollectionsPageProps) {
  await requireCurrentAdminPage();
  const [collections, productCounts] = await Promise.all([
    repository.listForAdmin(100),
    productRepository.countProductsByCollectionSlug(),
  ]);

  const query = await searchParams;
  const saved = queryValue(query.saved) === "1";
  const invalid = queryValue(query.error) === "invalid";
  const formStatus = invalid ? "error" : saved ? "success" : null;

  return (
    <div className="mx-auto max-w-6xl">
      <div className="grid gap-6 border-b border-black/20 pb-8 md:grid-cols-[1fr_0.7fr] md:items-end">
        <div>
          <Link
            className="text-xs font-semibold uppercase tracking-[0.14em] text-black/60 underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-4"
            href="/admin"
          >
            ← Quản trị sản phẩm
          </Link>
          <p className="eyebrow mt-8">Website taxonomy</p>
          <h1 className="mt-3 max-w-4xl font-display text-5xl leading-[0.95] tracking-[-0.05em] md:text-7xl">
            Quản lý collections
          </h1>
        </div>
        <p className="max-w-xl font-display text-lg leading-relaxed md:justify-self-end">
          Collection là dữ liệu website-owned. Mapping category từ Pancake chỉ là gợi ý explicit và không có quyền tự publish.
        </p>
      </div>

      <CollectionAdminStatus kind={formStatus} />

      <section className="py-10" aria-labelledby="new-collection-title">
        <p className="eyebrow">Tạo mới</p>
        <h2 id="new-collection-title" className="mt-2 font-display text-3xl tracking-[-0.03em]">
          Collection mới
        </h2>
        <div className="mt-8 border-t border-black/20 pt-8">
          <CollectionForm key={`new-${formStatus ?? "idle"}`} action={createCollection} />
        </div>
      </section>

      <section className="border-t border-black/20 py-10" aria-labelledby="existing-collections-title">
        <p className="eyebrow">Đã lưu</p>
        <h2 id="existing-collections-title" className="mt-2 font-display text-3xl tracking-[-0.03em]">
          Collections hiện có
        </h2>

        {collections.length === 0 ? (
          <p className="mt-6 max-w-2xl text-sm leading-6 text-black/65">
            Chưa có collection. Tạo definition đầu tiên ở form phía trên; hệ thống không tự sinh collection từ POS.
          </p>
        ) : (
          <>
            <div className="mt-8 overflow-x-auto border-y border-black/20">
              <table className="w-full min-w-[44rem] border-collapse text-left">
                <caption className="sr-only">
                  Tổng quan collection với trạng thái publish và số sản phẩm đang thuộc về
                </caption>
                <thead>
                  <tr className="border-b border-black/20 text-[0.65rem] uppercase tracking-[0.14em] text-black/60">
                    <th className="py-3 pr-4 font-semibold" scope="col">
                      Collection
                    </th>
                    <th className="py-3 pr-4 font-semibold" scope="col">
                      Trạng thái
                    </th>
                    <th className="py-3 pr-4 font-semibold" scope="col">
                      Mô tả
                    </th>
                    <th className="py-3 pr-4 font-semibold" scope="col">
                      Sản phẩm
                    </th>
                    <th className="py-3 font-semibold" scope="col">
                      <span className="sr-only">Hành động</span>
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-black/12">
                  {collections.map((definition) => {
                    const count = productCounts.get(definition.slug) ?? 0;
                    const hasDescription = (definition.description ?? "").trim().length > 0;

                    return (
                      <tr className="align-middle transition-colors hover:bg-black/[0.03]" key={definition.slug}>
                        <td className="py-3 pr-4">
                          <a
                            className="font-display text-lg leading-tight tracking-[-0.02em] underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-4"
                            href={`#collection-${definition.slug}`}
                          >
                            {definition.title}
                          </a>
                          <p className="mt-1 text-xs text-black/55">/{definition.slug}</p>
                        </td>
                        <td className="py-3 pr-4">
                          <span
                            className={`inline-block rounded-full px-2 py-0.5 text-[0.65rem] font-semibold uppercase tracking-wider ${
                              definition.isPublished
                                ? "bg-emerald-100 text-emerald-900"
                                : "bg-black/10 text-black/70"
                            }`}
                          >
                            {definition.isPublished ? "Published" : "Draft"}
                          </span>
                        </td>
                        <td className="py-3 pr-4 text-xs">
                          {hasDescription ? (
                            <span className="text-black/60">Có</span>
                          ) : (
                            <span className="font-semibold text-amber-800">
                              Thiếu — không thể publish
                            </span>
                          )}
                        </td>
                        <td className="py-3 pr-4 text-sm font-semibold">{count}</td>
                        <td className="py-3">
                          <Link
                            className="inline-flex min-h-11 items-center border border-black/25 px-4 py-2 text-xs font-semibold uppercase tracking-[0.14em] transition-colors hover:border-black focus-visible:outline-2 focus-visible:outline-offset-4"
                            href={`/admin?collection=${definition.slug}`}
                          >
                            Xem sản phẩm
                            <span className="sr-only"> thuộc {definition.title}</span>
                          </Link>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="mt-8 divide-y divide-black/20 border-y border-black/20">
            {collections.map((definition) => (
              <article key={definition.slug} className="py-10" id={`collection-${definition.slug}`}>
                <div className="mb-8 flex flex-wrap items-center gap-x-4 gap-y-2">
                  <h3 className="font-display text-2xl tracking-[-0.025em]">{definition.title}</h3>
                  <span className="text-[0.65rem] font-semibold uppercase tracking-[0.14em] text-black/55">
                    {definition.isPublished ? "Published" : "Draft"}
                  </span>
                  {definition.homepagePosition !== null ? (
                    <span className="text-[0.65rem] font-semibold uppercase tracking-[0.14em] text-black/55">
                      Trang chủ #{definition.homepagePosition}
                    </span>
                  ) : null}
                  <span className="text-[0.65rem] font-semibold uppercase tracking-[0.14em] text-black/55">
                    {productCounts.get(definition.slug) ?? 0} sản phẩm
                  </span>
                </div>
                <CollectionForm
                  action={updateCollection.bind(null, definition.slug)}
                  definition={definition}
                />
              </article>
            ))}
            </div>
          </>
        )}

        {collections.length === 100 ? (
          <p className="mt-6 text-xs leading-5 text-black/60">
            Đang hiển thị tối đa 100 collection trong foundation hiện tại.
          </p>
        ) : null}
      </section>
    </div>
  );
}
