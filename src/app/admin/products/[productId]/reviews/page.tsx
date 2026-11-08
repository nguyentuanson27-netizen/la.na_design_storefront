import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { revalidatePath } from "next/cache";
import { notFound, redirect } from "next/navigation";

import { requireCurrentAdmin, requireCurrentAdminPage } from "@/auth/current-admin";
import {
  PRODUCT_REVIEW_FITS,
  PRODUCT_REVIEW_FIT_LABELS,
  PRODUCT_REVIEW_LIMITS,
  PRODUCT_REVIEW_SOURCES,
  PRODUCT_REVIEW_SOURCE_LABELS,
  formatReviewDate,
  parseProductReviewInput,
  type ProductReviewInputField,
} from "@/commerce/product-review";
import {
  createProductReviewRepository,
  type ProductReviewAdminRow,
  type ProductReviewOrderCheck,
} from "@/commerce/product-review-repository";
import { prisma } from "@/db/prisma";

export const metadata: Metadata = {
  title: "Đánh giá khách",
};

const repository = createProductReviewRepository(prisma);

const inputClassName =
  "w-full border-b border-black/30 bg-transparent px-0 py-3 text-base outline-none transition-colors placeholder:text-black/35 focus-visible:border-black focus-visible:outline-2 focus-visible:outline-offset-4";
const labelClassName = "text-xs font-semibold uppercase tracking-[0.13em]";
const hintClassName = "mt-2 block text-xs leading-5 text-black/55";
const primaryButton =
  "min-h-11 bg-black px-6 text-xs font-semibold uppercase tracking-[0.14em] text-white focus-visible:outline-2 focus-visible:outline-offset-4";
const secondaryButton =
  "min-h-11 border border-black/40 px-4 text-xs font-semibold uppercase tracking-[0.14em] focus-visible:outline-2 focus-visible:outline-offset-4";

const FIELD_MESSAGES: Record<ProductReviewInputField, string> = {
  rating: "Chọn số sao từ 1 đến 5.",
  authorName:
    "Tên hiển thị chưa hợp lệ. Dùng tên gọi và chữ cái đầu của họ, ví dụ “Lan A.” hoặc “Thu Hà T.”. Không ghi họ tên đầy đủ, số điện thoại, email hay số.",
  body: `Nội dung dài quá ${PRODUCT_REVIEW_LIMITS.body} ký tự.`,
  source: "Chọn nguồn của đánh giá.",
  fit: "Mức vừa vặn chưa hợp lệ.",
  sizeLabel: `Size dài quá ${PRODUCT_REVIEW_LIMITS.label} ký tự.`,
  colorLabel: `Màu dài quá ${PRODUCT_REVIEW_LIMITS.label} ký tự.`,
  heightCm: "Chiều cao phải từ 100 đến 220 cm.",
  weightKg: "Cân nặng phải từ 25 đến 200 kg.",
  imageUrls: `Link ảnh chưa hợp lệ. Mỗi dòng một link .jpg, .png hoặc .webp trên content.pancake.vn, tối đa ${PRODUCT_REVIEW_LIMITS.images} ảnh.`,
  orderPublicCode: "Mã đơn hàng quá dài.",
  shopReply: `Câu trả lời dài quá ${PRODUCT_REVIEW_LIMITS.shopReply} ký tự.`,
  reviewedAt: "Ngày không hợp lệ hoặc nằm trong tương lai. Nhập ngày khách gửi đánh giá.",
  consent: "Cần xác nhận khách đã đồng ý cho đăng trước khi lưu.",
  status: "Trạng thái chưa hợp lệ.",
  content: "Cần có nội dung đánh giá hoặc ít nhất một ảnh.",
};

const ORDER_MESSAGES: Record<Exclude<ProductReviewOrderCheck, "OK">, string> = {
  ORDER_NOT_FOUND: "Không tìm thấy đơn hàng với mã này. Kiểm tra lại mã đơn, hoặc để trống nếu không gắn đơn.",
  ORDER_NOT_CONFIRMED: "Đơn này chưa được xác nhận nên chưa thể gắn nhãn “Đã mua hàng”.",
  ORDER_LACKS_PRODUCT: "Đơn này không có sản phẩm này nên không thể gắn nhãn “Đã mua hàng”.",
};

/**
 * Module-level on purpose: a server action defined inside the page closes over what it uses, and
 * Next cannot serialize a function among those. A path string it can.
 */
function refreshReviewPages(pagePath: string) {
  revalidatePath(pagePath);
  revalidatePath("/shop/[slug]", "page");
}

function queryValue(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : value?.[0];
}

/** Today in Vietnam (UTC+7) as `YYYY-MM-DD`, the default and the ceiling of the date field. */
function todayInVietnam(): string {
  return new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function dateInputValue(date: Date): string {
  return new Date(date.getTime() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

type AdminProductReviewsPageProps = {
  params: Promise<{ productId: string }>;
  searchParams: Promise<{
    edit?: string | string[];
    saved?: string | string[];
    error?: string | string[];
    orderError?: string | string[];
  }>;
};

export default async function AdminProductReviewsPage({ params, searchParams }: AdminProductReviewsPageProps) {
  const { productId } = await params;
  if (productId.length === 0 || productId.length > 64 || productId !== productId.trim()) notFound();

  await requireCurrentAdminPage();
  const product = await prisma.productMirror.findUnique({
    where: { id: productId },
    select: { id: true, name: true, slug: true },
  });
  if (!product) notFound();

  const persistedProductId = product.id;
  const persistedProductSlug = product.slug;
  const pagePath = `/admin/products/${persistedProductId}/reviews`;

  async function saveReview(formData: FormData) {
    "use server";

    await requireCurrentAdmin();
    const rawId = formData.get("reviewId");
    const reviewId = typeof rawId === "string" && rawId.length > 0 ? rawId : null;
    const editSuffix = reviewId === null ? "" : `&edit=${encodeURIComponent(reviewId)}`;

    const now = new Date();
    const parsed = parseProductReviewInput(Object.fromEntries(formData), now);
    if (!parsed.ok) redirect(`${pagePath}?error=${parsed.field}${editSuffix}`);

    if (parsed.value.orderPublicCode !== null) {
      const check = await repository.checkOrderForProduct(persistedProductId, parsed.value.orderPublicCode);
      if (check !== "OK") redirect(`${pagePath}?orderError=${check}${editSuffix}`);
    }

    if (reviewId === null) {
      await repository.create(persistedProductId, parsed.value, now);
    } else if (!(await repository.update(persistedProductId, reviewId, parsed.value, now))) {
      redirect(`${pagePath}?error=content`);
    }

    refreshReviewPages(pagePath);
    redirect(`${pagePath}?saved=1`);
  }

  async function setReviewStatus(formData: FormData) {
    "use server";

    await requireCurrentAdmin();
    const reviewId = formData.get("reviewId");
    const status = formData.get("status");
    if (typeof reviewId === "string" && (status === "PUBLISHED" || status === "DRAFT")) {
      await repository.setStatus(persistedProductId, reviewId, status);
    }
    refreshReviewPages(pagePath);
    redirect(`${pagePath}?saved=1`);
  }

  async function deleteReview(formData: FormData) {
    "use server";

    await requireCurrentAdmin();
    const reviewId = formData.get("reviewId");
    if (typeof reviewId === "string") await repository.remove(persistedProductId, reviewId);
    refreshReviewPages(pagePath);
    redirect(`${pagePath}?saved=1`);
  }

  const query = await searchParams;
  const reviews = await repository.listForAdmin(persistedProductId);
  const editId = queryValue(query.edit);
  const editing: ProductReviewAdminRow | null =
    editId === undefined ? null : reviews.find((review) => review.id === editId) ?? null;

  const errorField = queryValue(query.error) as ProductReviewInputField | undefined;
  const orderError = queryValue(query.orderError) as Exclude<ProductReviewOrderCheck, "OK"> | undefined;
  const errorMessage =
    errorField !== undefined && errorField in FIELD_MESSAGES
      ? FIELD_MESSAGES[errorField]
      : orderError !== undefined && orderError in ORDER_MESSAGES
        ? ORDER_MESSAGES[orderError]
        : null;
  const saved = queryValue(query.saved) === "1";

  const published = reviews.filter((review) => review.status === "PUBLISHED").length;
  const today = todayInVietnam();

  return (
    <div className="mx-auto max-w-5xl">
      <div className="border-b border-black/20 pb-8">
        <Link
          className="text-xs font-semibold uppercase tracking-[0.14em] text-black/60 underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-4"
          href={`/admin/products/${persistedProductId}`}
        >
          ← Biên tập sản phẩm
        </Link>
        <p className="eyebrow mt-8">Đánh giá khách</p>
        <h1 className="mt-3 max-w-4xl font-display text-4xl leading-[1] tracking-[-0.04em] md:text-6xl">
          {product.name}
        </h1>
        <p className="mt-6 max-w-2xl text-sm leading-6 text-black/70">
          Chỉ nhập đánh giá có thật mà khách đã gửi và đồng ý cho đăng. Số sao trung bình do hệ thống tự tính từ các
          đánh giá đang hiển thị ({published}/{reviews.length}); trang sản phẩm chỉ hiện điểm trung bình khi có từ 5
          đánh giá. Nhãn “Đã mua hàng” chỉ xuất hiện khi gắn đúng mã một đơn đã xác nhận có sản phẩm này.
        </p>
        <p className="mt-3 text-xs text-black/55">
          <Link className="underline underline-offset-4" href={`/shop/${persistedProductSlug}`} target="_blank">
            Xem trang sản phẩm
          </Link>
        </p>
      </div>

      <div className="mt-6 min-h-6" role={errorMessage ? "alert" : "status"} aria-atomic="true">
        {saved ? <p className="border-l-2 border-black pl-4 text-sm font-semibold">Đã lưu.</p> : null}
        {errorMessage ? <p className="border-l-2 border-black pl-4 text-sm font-semibold">{errorMessage}</p> : null}
      </div>

      <form action={saveReview} id="review-form" className="scroll-mt-8 mt-8 space-y-7 border-b border-black/20 pb-12" key={editing?.id ?? "new"}>
        <h2 className="font-display text-3xl tracking-[-0.03em]">
          {editing ? "Sửa đánh giá" : "Thêm đánh giá"}
        </h2>
        {editing ? <input name="reviewId" type="hidden" value={editing.id} /> : null}

        <div className="grid gap-7 md:grid-cols-3">
          <label className="block">
            <span className={labelClassName}>Số sao</span>
            <select className={inputClassName} defaultValue={editing?.rating ?? 5} name="rating" required>
              {[5, 4, 3, 2, 1].map((stars) => (
                <option key={stars} value={stars}>
                  {stars} sao
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className={labelClassName}>Tên hiển thị</span>
            <input
              className={inputClassName}
              defaultValue={editing?.authorName ?? ""}
              maxLength={PRODUCT_REVIEW_LIMITS.authorName}
              name="authorName"
              placeholder="Lan A."
              required
              type="text"
            />
            <span className={hintClassName}>
              Tên gọi + chữ cái đầu của họ, ví dụ “Lan A.”. Không ghi họ tên đầy đủ, số điện thoại hay email.
            </span>
          </label>
          <label className="block">
            <span className={labelClassName}>Ngày khách gửi</span>
            <input
              className={inputClassName}
              defaultValue={editing ? dateInputValue(editing.reviewedAt) : today}
              max={today}
              min="2020-01-01"
              name="reviewedAt"
              required
              type="date"
            />
            <span className={hintClassName}>Ngày của đánh giá gốc, không phải ngày nhập.</span>
          </label>
        </div>

        <label className="block">
          <span className={labelClassName}>Nội dung đánh giá</span>
          <textarea
            className={`${inputClassName} min-h-28`}
            defaultValue={editing?.body ?? ""}
            maxLength={PRODUCT_REVIEW_LIMITS.body}
            name="body"
            rows={4}
          />
          <span className={hintClassName}>
            Giữ nguyên lời khách; chỉ sửa lỗi chính tả. Cần có nội dung hoặc ít nhất một ảnh.
          </span>
        </label>

        <div className="grid gap-7 md:grid-cols-3">
          <label className="block">
            <span className={labelClassName}>Nguồn</span>
            <select className={inputClassName} defaultValue={editing?.source ?? "ZALO"} name="source" required>
              {PRODUCT_REVIEW_SOURCES.map((source) => (
                <option key={source} value={source}>
                  {PRODUCT_REVIEW_SOURCE_LABELS[source]}
                </option>
              ))}
            </select>
            <span className={hintClassName}>Hiện công khai để người đọc biết đánh giá đến từ đâu.</span>
          </label>
          <label className="block">
            <span className={labelClassName}>Mã đơn hàng (tùy chọn)</span>
            <input
              className={inputClassName}
              defaultValue={editing?.orderPublicCode ?? ""}
              maxLength={PRODUCT_REVIEW_LIMITS.orderPublicCode}
              name="orderPublicCode"
              type="text"
            />
            <span className={hintClassName}>
              Chỉ điền khi đúng khách đã mua sản phẩm này; hệ thống kiểm tra đơn rồi mới gắn “Đã mua hàng”.
            </span>
          </label>
          <label className="block">
            <span className={labelClassName}>Trạng thái</span>
            <select className={inputClassName} defaultValue={editing?.status ?? "PUBLISHED"} name="status" required>
              <option value="PUBLISHED">Hiển thị trên trang sản phẩm</option>
              <option value="DRAFT">Lưu nháp (đang ẩn)</option>
            </select>
          </label>
        </div>

        <div className="grid gap-7 md:grid-cols-5">
          <label className="block">
            <span className={labelClassName}>Size đã mua</span>
            <input className={inputClassName} defaultValue={editing?.sizeLabel ?? ""} maxLength={PRODUCT_REVIEW_LIMITS.label} name="sizeLabel" placeholder="M" type="text" />
          </label>
          <label className="block">
            <span className={labelClassName}>Màu</span>
            <input className={inputClassName} defaultValue={editing?.colorLabel ?? ""} maxLength={PRODUCT_REVIEW_LIMITS.label} name="colorLabel" placeholder="Hồng phấn" type="text" />
          </label>
          <label className="block">
            <span className={labelClassName}>Vừa vặn</span>
            <select className={inputClassName} defaultValue={editing?.fit ?? ""} name="fit">
              <option value="">Không rõ</option>
              {PRODUCT_REVIEW_FITS.map((fit) => (
                <option key={fit} value={fit}>
                  {PRODUCT_REVIEW_FIT_LABELS[fit]}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className={labelClassName}>Cao (cm)</span>
            <input className={inputClassName} defaultValue={editing?.heightCm ?? ""} inputMode="numeric" max={220} min={100} name="heightCm" type="number" />
          </label>
          <label className="block">
            <span className={labelClassName}>Nặng (kg)</span>
            <input className={inputClassName} defaultValue={editing?.weightKg ?? ""} inputMode="numeric" max={200} min={25} name="weightKg" type="number" />
          </label>
        </div>
        <p className="-mt-3 text-xs leading-5 text-black/55">
          Chiều cao và cân nặng hiện công khai để khách khác tham khảo size; chỉ điền khi khách đồng ý.
        </p>

        <label className="block">
          <span className={labelClassName}>Link ảnh khách (mỗi dòng một link)</span>
          <textarea
            className={`${inputClassName} min-h-24 font-mono text-sm`}
            defaultValue={editing?.imageUrls.join("\n") ?? ""}
            name="imageUrls"
            placeholder="https://content.pancake.vn/…/anh-khach-1.jpg"
            rows={3}
          />
          <span className={hintClassName}>
            Tối đa {PRODUCT_REVIEW_LIMITS.images} ảnh .jpg, .png hoặc .webp trên content.pancake.vn. Ảnh dọc, thấy cả bộ
            đồ là đẹp nhất.
          </span>
        </label>

        <label className="block">
          <span className={labelClassName}>Shop trả lời (tùy chọn)</span>
          <textarea
            className={`${inputClassName} min-h-20`}
            defaultValue={editing?.shopReply ?? ""}
            maxLength={PRODUCT_REVIEW_LIMITS.shopReply}
            name="shopReply"
            rows={2}
          />
        </label>

        <label className="flex items-start gap-3 border border-black/25 p-4">
          <input className="mt-1 h-4 w-4" name="consent" required type="checkbox" />
          <span className="text-sm leading-6">
            Khách đã đồng ý cho đăng đánh giá này cùng ảnh và thông tin kèm theo (nguồn: tin nhắn hoặc bình luận khách
            gửi). Đây là đánh giá thật, không do shop viết.
          </span>
        </label>

        <div className="flex flex-wrap gap-3">
          <button className={primaryButton} type="submit">
            {editing ? "Lưu thay đổi" : "Thêm đánh giá"}
          </button>
          {editing ? (
            <Link className={`${secondaryButton} inline-flex items-center`} href={pagePath}>
              Hủy sửa
            </Link>
          ) : null}
        </div>
      </form>

      <section aria-labelledby="review-list-title" className="mt-12">
        <h2 id="review-list-title" className="font-display text-3xl tracking-[-0.03em]">
          Đánh giá đã nhập ({reviews.length})
        </h2>
        {reviews.length === 0 ? (
          <p className="mt-6 text-sm text-black/60">Chưa có đánh giá nào cho sản phẩm này.</p>
        ) : (
          <ul className="mt-6 divide-y divide-black/15 border-y border-black/15">
            {reviews.map((review) => (
              <li className="grid gap-4 py-6 md:grid-cols-[1fr_auto]" key={review.id}>
                <div className="min-w-0">
                  <p className="text-sm font-semibold">
                    {review.rating} sao · {review.authorName}{" "}
                    <span className="font-normal text-black/55">
                      · {formatReviewDate(review.reviewedAt)} · {PRODUCT_REVIEW_SOURCE_LABELS[review.source]}
                    </span>
                  </p>
                  <p className="mt-1 text-xs font-semibold uppercase tracking-[0.12em]">
                    {review.status === "PUBLISHED" ? "Đang hiển thị" : "Đang ẩn (nháp)"}
                    {review.orderPublicCode ? (
                      <span className="ml-3 normal-case tracking-normal text-[#2F5D3A]">
                        ✓ Đã gắn đơn {review.orderPublicCode}
                      </span>
                    ) : null}
                  </p>
                  {review.body ? (
                    <p className="mt-3 line-clamp-3 whitespace-pre-line text-sm leading-6 text-black/75">{review.body}</p>
                  ) : null}
                  {review.imageUrls.length > 0 ? (
                    <ul className="mt-3 flex flex-wrap gap-2">
                      {review.imageUrls.map((url, index) => (
                        <li className="relative h-16 w-12 overflow-hidden bg-black/5" key={`${index}-${url}`}>
                          <Image alt="" className="object-cover" fill sizes="48px" src={url} />
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
                <div className="flex flex-wrap items-start gap-2 md:flex-col md:items-stretch">
                  <Link className={`${secondaryButton} inline-flex items-center justify-center`} href={`${pagePath}?edit=${review.id}#review-form`}>
                    Sửa
                  </Link>
                  <form action={setReviewStatus}>
                    <input name="reviewId" type="hidden" value={review.id} />
                    <input name="status" type="hidden" value={review.status === "PUBLISHED" ? "DRAFT" : "PUBLISHED"} />
                    <button className={`${secondaryButton} w-full`} type="submit">
                      {review.status === "PUBLISHED" ? "Ẩn" : "Hiển thị"}
                    </button>
                  </form>
                  <details className="text-xs">
                    <summary className="min-h-11 cursor-pointer py-3 text-black/60 underline underline-offset-4">
                      Xóa vĩnh viễn…
                    </summary>
                    <form action={deleteReview} className="mt-2">
                      <input name="reviewId" type="hidden" value={review.id} />
                      <button className={`${secondaryButton} w-full border-[#9A3324] text-[#9A3324]`} type="submit">
                        Xác nhận xóa
                      </button>
                    </form>
                  </details>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
