import type { PrismaClient } from "../generated/prisma/client.ts";
import {
  buildProductReviewSection,
  type ProductReviewRow,
  type ProductReviewSection,
  type ProductReviewValue,
} from "./product-review.ts";

/**
 * Storage for hand-entered customer reviews.
 *
 * Everything the storefront prints is derived from these rows (`buildProductReviewSection`), so the
 * only writes are the admin's. The one cross-table rule lives here: a review may carry an order code
 * (which earns "Đã mua hàng") only when that order is CONFIRMED and contains this product.
 */

/**
 * Published rows read for one product page. The summary counts all of them, so this is the ceiling
 * of what a single product's average can see; a shop entering reviews by hand will not approach it.
 */
export const PRODUCT_REVIEW_READ_CAP = 500;

export type ProductReviewOrderCheck =
  | "OK"
  | "ORDER_NOT_FOUND"
  | "ORDER_NOT_CONFIRMED"
  | "ORDER_LACKS_PRODUCT";

export type ProductReviewAdminRow = ProductReviewRow &
  Readonly<{
    status: "DRAFT" | "PUBLISHED";
    createdAt: Date;
    updatedAt: Date;
  }>;

const ROW_SELECT = {
  id: true,
  rating: true,
  authorName: true,
  body: true,
  source: true,
  fit: true,
  sizeLabel: true,
  colorLabel: true,
  heightCm: true,
  weightKg: true,
  imageUrls: true,
  orderPublicCode: true,
  shopReply: true,
  reviewedAt: true,
} as const;

const ADMIN_SELECT = {
  ...ROW_SELECT,
  status: true,
  createdAt: true,
  updatedAt: true,
} as const;

export function createProductReviewRepository(client: PrismaClient) {
  /** The page's reviews: published rows only, newest review first. */
  async function readSection(productId: string): Promise<ProductReviewSection | null> {
    const rows = await client.productReview.findMany({
      where: { productId, status: "PUBLISHED" },
      select: ROW_SELECT,
      orderBy: [{ reviewedAt: "desc" }, { id: "desc" }],
      take: PRODUCT_REVIEW_READ_CAP,
    });
    return buildProductReviewSection(rows);
  }

  async function listForAdmin(productId: string): Promise<readonly ProductReviewAdminRow[]> {
    return client.productReview.findMany({
      where: { productId },
      select: ADMIN_SELECT,
      orderBy: [{ reviewedAt: "desc" }, { id: "desc" }],
      take: PRODUCT_REVIEW_READ_CAP,
    });
  }

  async function findForAdmin(
    productId: string,
    reviewId: string,
  ): Promise<ProductReviewAdminRow | null> {
    return client.productReview.findFirst({
      where: { id: reviewId, productId },
      select: ADMIN_SELECT,
    });
  }

  /**
   * Whether an order may verify a review of this product: it exists, is CONFIRMED, and one of its
   * lines is this product -- by the PDP the line was bought from (`metaContentId`, which the order
   * freezes) or by the variant's own product.
   */
  async function checkOrderForProduct(
    productId: string,
    orderPublicCode: string,
  ): Promise<ProductReviewOrderCheck> {
    const order = await client.orderMirror.findUnique({
      where: { publicCode: orderPublicCode },
      select: {
        state: true,
        lines: { select: { variantId: true, metaContentId: true } },
      },
    });
    if (!order) return "ORDER_NOT_FOUND";
    if (order.state !== "CONFIRMED") return "ORDER_NOT_CONFIRMED";

    const product = await client.productMirror.findUnique({
      where: { id: productId },
      select: { slug: true },
    });
    if (!product) return "ORDER_LACKS_PRODUCT";
    if (order.lines.some((line) => line.metaContentId === product.slug)) return "OK";

    const variantIds = order.lines.map((line) => line.variantId);
    if (variantIds.length === 0) return "ORDER_LACKS_PRODUCT";
    const owned = await client.variantMirror.count({
      where: { id: { in: variantIds }, productId },
    });
    return owned > 0 ? "OK" : "ORDER_LACKS_PRODUCT";
  }

  function data(value: ProductReviewValue, now: Date) {
    return {
      status: value.status,
      rating: value.rating,
      authorName: value.authorName,
      body: value.body,
      source: value.source,
      fit: value.fit,
      sizeLabel: value.sizeLabel,
      colorLabel: value.colorLabel,
      heightCm: value.heightCm,
      weightKg: value.weightKg,
      imageUrls: [...value.imageUrls],
      orderPublicCode: value.orderPublicCode,
      shopReply: value.shopReply,
      reviewedAt: value.reviewedAt,
      consentConfirmedAt: now,
    };
  }

  async function create(productId: string, value: ProductReviewValue, now = new Date()) {
    return client.productReview.create({
      data: { productId, ...data(value, now) },
      select: { id: true },
    });
  }

  /** `false` when the review is not this product's (so a forged id edits nothing). */
  async function update(
    productId: string,
    reviewId: string,
    value: ProductReviewValue,
    now = new Date(),
  ): Promise<boolean> {
    const result = await client.productReview.updateMany({
      where: { id: reviewId, productId },
      data: data(value, now),
    });
    return result.count === 1;
  }

  async function setStatus(
    productId: string,
    reviewId: string,
    status: "DRAFT" | "PUBLISHED",
  ): Promise<boolean> {
    const result = await client.productReview.updateMany({
      where: { id: reviewId, productId },
      data: { status },
    });
    return result.count === 1;
  }

  async function remove(productId: string, reviewId: string): Promise<boolean> {
    const result = await client.productReview.deleteMany({ where: { id: reviewId, productId } });
    return result.count === 1;
  }

  return {
    readSection,
    listForAdmin,
    findForAdmin,
    checkOrderForProduct,
    create,
    update,
    setStatus,
    remove,
  };
}

export type ProductReviewRepository = ReturnType<typeof createProductReviewRepository>;
