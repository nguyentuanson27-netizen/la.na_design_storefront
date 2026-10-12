import { Prisma, type PrismaClient } from "../generated/prisma/client.ts";
import { MerchandisingError, parseOrderedProductSelection } from "./merchandising-input.ts";
import { applyNewArrivalChange, parseNewArrivalOperation } from "./new-arrivals-selection.ts";

const MAX_PG_INT = 2_147_483_647;
const MAX_PAGE_SIZE = 48;
const MAX_OFFSET = 50_000;
const MAX_ADMIN_SEARCH = 80;
const ADMIN_SEARCH_RESULT_SIZE = 30;
const MAX_WRITE_ATTEMPTS = 3;

function parseShopId(shopId: number): number {
  if (!Number.isSafeInteger(shopId) || shopId < 1 || shopId > MAX_PG_INT) {
    throw new RangeError("Invalid shop id");
  }
  return shopId;
}

function visibleProduct(shopId: number) {
  return { pancakeShopId: shopId, isPresent: true, isActive: true };
}

function isWriteConflict(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    (error as { code?: unknown }).code === "P2034";
}

export function createNewArrivalsRepository(client: PrismaClient) {
  /** Includes inactive picks so an admin can remove them even though customers cannot see them. */
  async function listForAdmin(shopId: number) {
    return client.newArrivalProduct.findMany({
      where: { pancakeShopId: parseShopId(shopId) },
      orderBy: [{ position: "asc" }],
      select: {
        position: true,
        product: {
          select: { id: true, slug: true, name: true, isPresent: true, isActive: true },
        },
      },
    });
  }

  async function searchForAdmin(shopId: number, query: string) {
    const safeShopId = parseShopId(shopId);
    const q = query.trim();
    if (!q) return [];
    if (q.length > MAX_ADMIN_SEARCH) throw new RangeError("Search query is too long");

    return client.productMirror.findMany({
      where: {
        ...visibleProduct(safeShopId),
        OR: [
          { name: { contains: q, mode: "insensitive" } },
          { slug: { contains: q, mode: "insensitive" } },
          { productCode: { contains: q, mode: "insensitive" } },
        ],
      },
      orderBy: [{ name: "asc" }, { id: "asc" }],
      take: ADMIN_SEARCH_RESULT_SIZE,
      select: { id: true, slug: true, name: true },
    });
  }

  /** Filter eligibility BEFORE counting/pagination, not after taking the first 24. */
  async function listVisiblePage({
    shopId, page, pageSize,
  }: {
    shopId: number;
    page: number;
    pageSize: number;
  }) {
    const safeShopId = parseShopId(shopId);
    if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_SIZE) {
      throw new RangeError("Invalid new arrivals page size");
    }
    const offset = (page - 1) * pageSize;
    if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(offset) || offset > MAX_OFFSET) {
      throw new RangeError("Invalid new arrivals page");
    }

    const result = await client.$transaction(async (tx) => {
      const where = { pancakeShopId: safeShopId, product: visibleProduct(safeShopId) };
      const totalProducts = await tx.newArrivalProduct.count({ where });
      const entries = await tx.newArrivalProduct.findMany({
        where,
        orderBy: [{ position: "asc" }],
        skip: offset,
        take: pageSize,
        select: { productId: true },
      });
      return { totalProducts, ids: entries.map((entry) => entry.productId) };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });

    return {
      ...result,
      page,
      pageSize,
      totalPages: Math.ceil(result.totalProducts / pageSize),
    };
  }

  /**
   * One atomic replacement preserves unique ranks; the write can only be initiated by an admin.
   * Reads, deletes and ranks are all scoped to `shopId`, so a product id from another shop is
   * "not in the list" and is rejected rather than mutating that shop's selection.
   */
  async function applyChange({
    shopId, operation, productId,
  }: {
    shopId: number;
    operation: unknown;
    productId: unknown;
  }) {
    const safeShopId = parseShopId(shopId);
    const validOperation = parseNewArrivalOperation(operation);
    const [validProductId] = parseOrderedProductSelection([productId], { max: 1 });

    for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt++) {
      try {
        return await client.$transaction(async (tx) => {
          const entries = await tx.newArrivalProduct.findMany({
            where: { pancakeShopId: safeShopId },
            orderBy: [{ position: "asc" }],
            select: { productId: true },
          });
          const current = entries.map((entry) => entry.productId);

          if (validOperation === "add") {
            const exists = await tx.productMirror.count({
              where: { id: validProductId!, ...visibleProduct(safeShopId) },
            });
            if (exists !== 1) throw new MerchandisingError("merchandising-invalid-product");
          }

          const next = applyNewArrivalChange(current, validOperation, validProductId);
          if (next.length === current.length && next.every((id, i) => id === current[i])) {
            return next;
          }
          await tx.newArrivalProduct.deleteMany({ where: { pancakeShopId: safeShopId } });
          if (next.length > 0) {
            await tx.newArrivalProduct.createMany({
              data: next.map((id, position) => ({ productId: id, pancakeShopId: safeShopId, position })),
            });
          }
          return next;
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      } catch (error) {
        if (!isWriteConflict(error) || attempt === MAX_WRITE_ATTEMPTS - 1) throw error;
      }
    }
    throw new Error("Selection write retries exhausted");
  }

  return { listForAdmin, searchForAdmin, listVisiblePage, applyChange };
}
