import type { Metadata } from "next";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import Link from "next/link";

import { requireCurrentAdmin, requireCurrentAdminPage } from "@/auth/current-admin";
import { createNewArrivalsAdminService } from "@/commerce/new-arrivals-admin";
import { createNewArrivalsRepository } from "@/commerce/new-arrivals-repository";
import { MAX_NEW_ARRIVAL_PRODUCTS } from "@/commerce/new-arrivals-selection";
import { prisma } from "@/db/prisma";
import { readPancakeShopId } from "@/integrations/pancake/config";

export const metadata: Metadata = { title: "Quản lý Hàng mới về" };

const button = "inline-flex min-h-10 items-center justify-center border border-black px-4 py-2 text-xs font-semibold uppercase tracking-wide hover:bg-black hover:text-white focus-visible:outline-2 focus-visible:outline-offset-4";
const MAX_SEARCH_LENGTH = 80;

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

function single(value: string | string[] | undefined): string {
  return typeof value === "string" ? value : "";
}

const ERROR_MESSAGES = {
  stale: "Danh sách đã thay đổi hoặc sản phẩm không còn khả dụng. Danh sách đã được tải lại, vui lòng thử lại.",
  full: `Danh sách đã đạt tối đa ${MAX_NEW_ARRIVAL_PRODUCTS} sản phẩm. Hãy gỡ bớt trước khi thêm.`,
  invalid: "Thao tác không hợp lệ. Không có thay đổi nào được lưu.",
} as const;

type ErrorCode = keyof typeof ERROR_MESSAGES;

function errorCodeFor(reason: string): ErrorCode {
  if (reason === "merchandising-invalid-product") return "stale";
  if (reason === "merchandising-too-many") return "full";
  return "invalid";
}

function pageUrl(q: string, error?: ErrorCode): string {
  const params = new URLSearchParams();
  if (q) params.set("q", q);
  if (error) params.set("error", error);
  const query = params.toString();
  return query ? `/admin/new-arrivals?${query}` : "/admin/new-arrivals";
}

async function changeSelection(formData: FormData) {
  "use server";
  const session = await requireCurrentAdmin();
  const shopId = readPancakeShopId();
  const service = createNewArrivalsAdminService({
    shopId,
    repository: createNewArrivalsRepository(prisma),
  });
  const rawQuery = formData.get("q");
  const q = typeof rawQuery === "string" ? rawQuery.trim().slice(0, MAX_SEARCH_LENGTH) : "";
  const result = await service.update(session, {
    operation: formData.get("operation"),
    productId: formData.get("productId"),
  });
  revalidatePath("/new-arrivals");
  revalidatePath("/admin/new-arrivals");
  // A stale click (double submit, another admin changed the list) is an expected outcome, not a crash.
  redirect(pageUrl(q, result.ok ? undefined : errorCodeFor(result.reason)));
}

export default async function AdminNewArrivalsPage({ searchParams }: Props) {
  await requireCurrentAdminPage();
  await connection();
  const shopId = readPancakeShopId();
  const repository = createNewArrivalsRepository(prisma);
  const params = await searchParams;
  const q = single(params.q).trim().slice(0, MAX_SEARCH_LENGTH);
  const errorParam = single(params.error);
  const errorMessage = Object.hasOwn(ERROR_MESSAGES, errorParam)
    ? ERROR_MESSAGES[errorParam as ErrorCode]
    : null;
  const [selected, matches] = await Promise.all([
    repository.listForAdmin(shopId),
    repository.searchForAdmin(shopId, q),
  ]);
  const chosen = new Set(selected.map(({ product }) => product.id));

  return (
    <main className="mx-auto max-w-5xl space-y-10">
      <header className="border-b border-black/20 pb-6">
        <p className="eyebrow">Biên tập danh mục</p>
        <h1 className="mt-2 font-display text-4xl">Hàng mới về</h1>
        <p className="mt-3 text-sm leading-7 text-black/65">
          Chỉ các sản phẩm bạn chọn mới xuất hiện tại <Link className="underline" href="/new-arrivals">/new-arrivals</Link>.
          Không tự thêm từ Pancake và không tự hết hạn.
          Có thể chọn tối đa {MAX_NEW_ARRIVAL_PRODUCTS} sản phẩm.
        </p>
      </header>

      {errorMessage ? (
        <p role="alert" className="border border-red-800/40 p-4 text-sm text-red-900">{errorMessage}</p>
      ) : null}

      <section aria-labelledby="selected-title" className="space-y-5">
        <h2 id="selected-title" className="font-display text-2xl">
          Đang chọn ({selected.length})
        </h2>
        {selected.length === 0 ? (
          <p className="border border-black/20 p-6 text-sm">Danh sách đang trống. Tìm và thêm sản phẩm bên dưới.</p>
        ) : (
          <ol className="divide-y divide-black/15 border-y border-black/20">
            {selected.map(({ product }, index) => (
              <li key={product.id} className="flex flex-wrap items-center justify-between gap-4 py-4">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold">{index + 1}. {product.name}</p>
                  <p className="mt-1 text-xs text-black/55">/{product.slug}</p>
                  {!product.isActive || !product.isPresent ? (
                    <p className="mt-1 text-xs text-amber-800">Đang ẩn trên website</p>
                  ) : null}
                </div>
                <div className="flex flex-wrap gap-2">
                  {([
                    ["move-up", "Lên", index === 0],
                    ["move-down", "Xuống", index === selected.length - 1],
                    ["remove", "Gỡ", false],
                  ] as const).map(([operation, label, disabled]) => (
                    <form key={operation} action={changeSelection}>
                      <input type="hidden" name="operation" value={operation} />
                      <input type="hidden" name="q" value={q} />
                      <input type="hidden" name="productId" value={product.id} />
                      <button className={button} type="submit" disabled={disabled}
                        aria-label={`${label} ${product.name}`}>
                        {label}
                      </button>
                    </form>
                  ))}
                </div>
              </li>
            ))}
          </ol>
        )}
      </section>

      <section className="space-y-5" aria-labelledby="search-title">
        <h2 id="search-title" className="font-display text-2xl">Thêm sản phẩm</h2>
        <form action="/admin/new-arrivals" method="get" className="flex flex-wrap gap-3">
          <input type="search" name="q" defaultValue={q} maxLength={MAX_SEARCH_LENGTH}
            aria-label="Tên, mã hoặc slug sản phẩm" placeholder="Tìm theo tên, mã hoặc slug"
            className="min-h-11 min-w-0 flex-1 border border-black/30 px-3 py-2 text-sm" />
          <button className={button} type="submit">Tìm kiếm</button>
        </form>
        {!q ? (
          <p className="text-sm text-black/60">Nhập từ khoá để tìm sản phẩm trong catalog.</p>
        ) : matches.length === 0 ? (
          <p className="text-sm text-black/60">Không tìm thấy sản phẩm phù hợp.</p>
        ) : (
          <ul className="divide-y divide-black/15 border-y border-black/20">
            {matches.map((product) => (
              <li key={product.id} className="flex flex-wrap items-center justify-between gap-4 py-4">
                <div className="min-w-0">
                  <p className="text-sm font-semibold">{product.name}</p>
                  <p className="text-xs text-black/55">/{product.slug}</p>
                </div>
                {chosen.has(product.id) ? (
                  <span className="text-xs text-black/60">Đã chọn</span>
                ) : (
                  <form action={changeSelection}>
                    <input type="hidden" name="operation" value="add" />
                    <input type="hidden" name="q" value={q} />
                    <input type="hidden" name="productId" value={product.id} />
                    <button className={button} type="submit" disabled={selected.length >= MAX_NEW_ARRIVAL_PRODUCTS}
                      aria-label={`Thêm ${product.name} vào Hàng mới về`}>Thêm</button>
                  </form>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
