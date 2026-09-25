import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { APPROVED_SIZE_GUIDES } from "@/brand";
import { requireCurrentAdmin, requireCurrentAdminPage } from "@/auth/current-admin";
import { createSizeGuideMediaRepository, SizeGuideMediaError } from "@/commerce/size-guide-media";
import { prisma } from "@/db/prisma";

export const metadata: Metadata = {
  title: "Ảnh bảng size",
};

const repository = createSizeGuideMediaRepository(prisma);

const inputClassName =
  "w-full border-b border-black/30 bg-transparent px-0 py-3 text-base outline-none transition-colors placeholder:text-black/35 focus-visible:border-black focus-visible:outline-2 focus-visible:outline-offset-4";

async function saveSizeGuideImage(guideId: string, formData: FormData) {
  "use server";

  await requireCurrentAdmin();
  try {
    await repository.save({ guideId, imageUrl: formData.get("imageUrl") });
  } catch (error) {
    if (error instanceof SizeGuideMediaError) {
      redirect(`/admin/size-guides?error=${encodeURIComponent(guideId)}#guide-${guideId}`);
    }
    throw error;
  }

  // Every product page can show a guide, so the whole storefront shop tree is stale.
  revalidatePath("/shop/[slug]", "page");
  revalidatePath("/admin/size-guides");
  redirect(`/admin/size-guides?saved=${encodeURIComponent(guideId)}#guide-${guideId}`);
}

function queryValue(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : value?.[0];
}

type AdminSizeGuidesPageProps = {
  searchParams: Promise<{
    saved?: string | string[];
    error?: string | string[];
  }>;
};

export default async function AdminSizeGuidesPage({ searchParams }: AdminSizeGuidesPageProps) {
  await requireCurrentAdminPage();
  const [imageUrls, query] = await Promise.all([repository.listImageUrls(), searchParams]);
  const savedId = queryValue(query.saved);
  const errorId = queryValue(query.error);

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
          <p className="eyebrow mt-8">Trang sản phẩm</p>
          <h1 className="mt-3 max-w-4xl font-display text-5xl leading-[0.95] tracking-[-0.05em] md:text-7xl">
            Ảnh bảng size
          </h1>
        </div>
        <p className="max-w-xl font-display text-lg leading-relaxed md:justify-self-end">
          Ảnh hiện trong popup &quot;Hướng dẫn chọn size&quot;. Để trống thì popup hiển thị bảng số đo dạng chữ.
        </p>
      </div>

      <ul className="divide-y divide-black/15">
        {APPROVED_SIZE_GUIDES.map((guide) => {
          const imageUrl = imageUrls.get(guide.id) ?? null;
          const status = errorId === guide.id ? "error" : savedId === guide.id ? "success" : null;

          return (
            <li
              className="grid scroll-mt-8 gap-8 py-10 md:grid-cols-[1fr_16rem]"
              id={`guide-${guide.id}`}
              key={guide.id}
            >
              <form action={saveSizeGuideImage.bind(null, guide.id)} className="space-y-5">
                <h2 className="font-display text-3xl tracking-[-0.03em]">{guide.title}</h2>
                <label className="block">
                  <span className="text-xs font-semibold uppercase tracking-[0.13em]">Link ảnh</span>
                  <input
                    className={inputClassName}
                    defaultValue={imageUrl ?? ""}
                    name="imageUrl"
                    placeholder="https://content.pancake.vn/…/bang-size.webp"
                    type="url"
                  />
                  <span className="mt-2 block text-xs leading-5 text-black/55">
                    Chỉ nhận ảnh .jpg, .png hoặc .webp trên content.pancake.vn. Xoá trống rồi lưu để bỏ ảnh.
                  </span>
                </label>
                <div role={status === "error" ? "alert" : "status"} aria-atomic="true" className="min-h-6">
                  {status === "success" ? (
                    <p className="border-l-2 border-black pl-4 text-sm font-semibold">Đã lưu ảnh bảng size.</p>
                  ) : null}
                  {status === "error" ? (
                    <p className="border-l-2 border-black pl-4 text-sm font-semibold">
                      Link ảnh không hợp lệ. Dùng link ảnh .jpg, .png hoặc .webp trên content.pancake.vn.
                    </p>
                  ) : null}
                </div>
                <button
                  className="min-h-11 bg-black px-6 text-xs font-semibold uppercase tracking-[0.14em] text-white focus-visible:outline-2 focus-visible:outline-offset-4"
                  type="submit"
                >
                  Lưu
                </button>
              </form>

              <div className="flex aspect-square items-center justify-center border border-black/15 bg-black/[0.02]">
                {imageUrl ? (
                  <Image
                    alt={`Ảnh bảng size ${guide.title}`}
                    className="h-full w-full object-contain"
                    height={512}
                    sizes="16rem"
                    src={imageUrl}
                    width={512}
                  />
                ) : (
                  <p className="px-6 text-center text-xs leading-5 text-black/55">
                    Chưa có ảnh — popup đang hiển thị bảng dạng chữ.
                  </p>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
