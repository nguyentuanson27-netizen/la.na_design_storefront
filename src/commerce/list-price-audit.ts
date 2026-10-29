import type { PrismaClient } from "../generated/prisma/client.ts";
import { computeListPriceVnd } from "./list-price.ts";
import { readListPriceConfig } from "./list-price-config.ts";

export async function auditListPrices(
  input: Readonly<{
    client: PrismaClient;
    shopId: number;
    now: Date;
    force?: boolean;
    emit?: (summary: unknown) => void | Promise<void>;
  }>,
) {
  if (!input.force && !readListPriceConfig().display) return null;
  if (!Number.isSafeInteger(input.shopId) || input.shopId < 1)
    throw new Error("Invalid shop");
  try {
    return await input.client.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT "pancakeShopId" FROM "CatalogSyncState" WHERE "pancakeShopId" = ${input.shopId} FOR UPDATE`;
        const state = await tx.catalogSyncState.findUnique({
          where: { pancakeShopId: input.shopId },
        });
        if (!state) throw new Error("Catalog snapshot unavailable");
        if (
          !input.force &&
          state.listPriceAuditRetryAt &&
          state.listPriceAuditRetryAt > input.now
        )
          return null;
        const sameSync =
          state.listPriceAuditedSyncAt?.getTime() === state.syncedAt.getTime();
        if (
          !input.force &&
          !state.listPriceAuditError &&
          sameSync &&
          state.listPriceAuditAt &&
          input.now.getTime() - state.listPriceAuditAt.getTime() < 86400000
        )
          return null;
        const summary = {
          name: "list_price.catalog_audit",
          variants: 0,
          invalidPos: 0,
          unavailableList: 0,
          outliers: 0,
          minPos: null as number | null,
          maxRatio: 0,
          affectedVariantIds: [] as string[],
        };
        let cursor: string | undefined;
        for (;;) {
          const rows = await tx.variantMirror.findMany({
            where: { product: { pancakeShopId: input.shopId } },
            select: {
              id: true,
              pancakeVariationId: true,
              pancakeRetailPrice: true,
            },
            orderBy: { id: "asc" },
            take: 1000,
            ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
          });
          if (!rows.length) break;
          summary.variants += rows.length;
          if (summary.variants > 50000)
            throw new Error("Catalog audit bound exceeded");
          for (const row of rows) {
            const pos = row.pancakeRetailPrice;
            const list = computeListPriceVnd(pos);
            const valid = pos !== null && Number.isSafeInteger(pos) && pos > 0;
            const outlier =
              valid &&
              list !== null &&
              BigInt(list) * BigInt(2) > BigInt(pos) * BigInt(3);
            if (!valid) summary.invalidPos++;
            else {
              summary.minPos = Math.min(summary.minPos ?? pos, pos);
              if (list === null) summary.unavailableList++;
              else summary.maxRatio = Math.max(summary.maxRatio, list / pos);
            }
            if (outlier) summary.outliers++;
            if (
              (!valid || list === null || outlier) &&
              summary.affectedVariantIds.length < 50
            )
              summary.affectedVariantIds.push(row.pancakeVariationId);
          }
          cursor = rows.at(-1)!.id;
        }
        await (
          input.emit ?? ((summary) => console.warn(JSON.stringify(summary)))
        )(summary);
        await tx.catalogSyncState.update({
          where: { pancakeShopId: input.shopId },
          data: {
            listPriceAuditAt: input.now,
            listPriceAuditedSyncAt: state.syncedAt,
            listPriceAuditRetryAt: null,
            listPriceAuditError: false,
            listPriceAuditSummary: summary,
          },
        });
        return summary;
      },
      { timeout: 60000 },
    );
  } catch {
    await input.client.catalogSyncState.updateMany({
      where: { pancakeShopId: input.shopId },
      data: {
        listPriceAuditError: true,
        listPriceAuditRetryAt: new Date(input.now.getTime() + 60000),
      },
    });
    console.error("list_price.catalog_audit_failed: retry pending");
    throw new Error("List-price catalog audit failed");
  }
}
