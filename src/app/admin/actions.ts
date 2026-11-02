"use server";

import { revalidatePath } from "next/cache";

import { clearStorefrontRuntimeCaches } from "@/commerce/storefront-catalog-runtime";

import { readAuthServerConfig } from "@/auth/config";
import { requireCurrentAdmin } from "@/auth/current-admin";
import { AuthorizationError } from "@/auth/authorization";
import {
  createProductContentBulkCollectionAdminService,
  createProductContentBulkStatusAdminService,
  type ProductContentCollectionOperation,
  type ProductContentStatus,
} from "@/commerce/product-content-admin";
import { createProductContentRepository } from "@/commerce/product-content-repository";
import { createCollectionDefinitionRepository } from "@/commerce/collection-definition-repository";
import { createProductCatalogBulkAdminService } from "@/commerce/product-commerce-admin";
import {
  createProductCommerceRepository,
  type BulkVariantActivationMode,
} from "@/commerce/product-commerce-repository";
import { prisma } from "@/db/prisma";

const repository = createProductContentRepository(prisma);
const collectionRepository = createCollectionDefinitionRepository(prisma);
const commerceRepository = createProductCommerceRepository(prisma);
const bulkStatusAdminService = createProductContentBulkStatusAdminService({
  updateStatusesAtomically: repository.updateStatusesAtomically,
});
const bulkCollectionAdminService = createProductContentBulkCollectionAdminService({
  resolveCollectionSlugs: collectionRepository.resolveMembershipSlugs,
  updateCollectionMembershipAtomically: repository.updateCollectionMembershipAtomically,
});
const bulkCatalogAdminService = createProductCatalogBulkAdminService({
  readBulkCatalogEnableWarningState: commerceRepository.readBulkCatalogEnableWarningState,
  commitBulkCatalogEnable: commerceRepository.commitBulkCatalogEnable,
  disableBulkCatalog: commerceRepository.disableBulkCatalog,
  updateBulkVariantActivation: commerceRepository.updateBulkVariantActivation,
  readConfirmationSecret: () => readAuthServerConfig().secret,
  nowMs: () => Date.now(),
});

export type BulkProductStatusActionState =
  | { kind: "idle" }
  | { kind: "success"; updatedCount: number; status: ProductContentStatus }
  | { kind: "error"; message: string };

export type BulkProductCollectionActionState =
  | { kind: "idle" }
  | {
      kind: "success";
      operation: ProductContentCollectionOperation;
      collectionSlug: string;
      matchedCount: number;
      changedCount: number;
    }
  | { kind: "error"; message: string };

export type BulkProductCatalogActionState =
  | { kind: "idle" }
  | {
      kind: "confirm" | "reconfirm";
      productIds: string[];
      zeroActiveCount: number;
      compositeChildCount: number;
      proof: string;
      expiresAtMs: number;
    }
  | { kind: "success"; operation: "enable" | "disable"; updatedCount: number }
  | { kind: "error"; message: string };

export type BulkProductVariantActionState =
  | { kind: "idle" }
  | {
      kind: "success";
      mode: BulkVariantActivationMode;
      productCount: number;
      matchedVariantCount: number;
      changedVariantCount: number;
    }
  | { kind: "error"; message: string };

const genericBulkStatusError =
  "Không thể cập nhật trạng thái lúc này. Danh sách đã chọn được giữ nguyên để bạn thử lại.";
const genericBulkCollectionError =
  "Không thể cập nhật collection lúc này. Danh sách đã chọn được giữ nguyên để bạn thử lại.";
const genericBulkCatalogError =
  "Không thể cập nhật catalog lúc này. Danh sách đã chọn được giữ nguyên để bạn thử lại.";
const genericBulkError =
  "Không thể thực hiện thao tác lúc này. Danh sách đã chọn được giữ nguyên để bạn thử lại.";
const expiredSessionError =
  "Phiên quản trị không còn hợp lệ. Tải lại trang và đăng nhập lại.";
const staleSelectionError = "Có sản phẩm không còn tồn tại. Tải lại danh sách rồi thử lại.";

/** At most this many slugs are named before the message falls back to a count. */
const MAX_NAMED_BLOCKED_SLUGS = 5;

function describeBlockedSlugs(blockedSlugs: readonly string[]): string {
  return blockedSlugs.length > MAX_NAMED_BLOCKED_SLUGS
    ? `${blockedSlugs.length} sản phẩm`
    : blockedSlugs.map((slug) => `/${slug}`).join(", ");
}

/**
 * B5: a batch refused for a publish precondition is not an invalid selection, and saying so would
 * send the operator to re-pick products that are fine. The whole batch is left untouched, so the
 * message names what has to change before it can be retried.
 */
function bulkStatusErrorMessage(
  result: Exclude<Awaited<ReturnType<typeof bulkStatusAdminService.update>>, { ok: true }>,
): string {
  switch (result.reason) {
    case "PRODUCT_NOT_FOUND":
      return staleSelectionError;
    case "UNAVAILABLE":
      return genericBulkStatusError;
    case "SEO_INCOMPLETE":
      return `Chưa publish được: ${describeBlockedSlugs(result.blockedSlugs)} còn thiếu SEO title hoặc SEO description. Không sản phẩm nào được đổi trạng thái.`;
    case "SEO_PAIR_CONFLICT":
      return `Chưa publish được: cặp SEO title + description của ${describeBlockedSlugs(result.blockedSlugs)} trùng với sản phẩm đã publish khác. Không sản phẩm nào được đổi trạng thái.`;
    default:
      return "Lựa chọn hoặc trạng thái không hợp lệ. Kiểm tra lại rồi thử lại.";
  }
}

type AdminSession = Awaited<ReturnType<typeof requireCurrentAdmin>>;

/**
 * Only an authorization failure means the operator has to sign in again. Any other failure is an
 * infrastructure fault, and telling a valid admin their session expired would send them to
 * re-authenticate over a problem that has nothing to do with their session.
 */
async function readAdminSession(): Promise<
  { ok: true; session: AdminSession } | { ok: false; message: string }
> {
  try {
    return { ok: true, session: await requireCurrentAdmin() };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof AuthorizationError ? expiredSessionError : genericBulkError,
    };
  }
}

function revalidateDirectory(): void {
  clearStorefrontRuntimeCaches();
  revalidatePath("/admin");
  revalidatePath("/shop");
}

export async function bulkUpdateProductStatusAction(
  _previousState: BulkProductStatusActionState,
  formData: FormData,
): Promise<BulkProductStatusActionState> {
  let adminSession: Awaited<ReturnType<typeof requireCurrentAdmin>>;
  try {
    adminSession = await requireCurrentAdmin();
  } catch (error) {
    if (error instanceof AuthorizationError) {
      return {
        kind: "error",
        message: expiredSessionError,
      };
    }
    return { kind: "error", message: genericBulkStatusError };
  }

  let result: Awaited<ReturnType<typeof bulkStatusAdminService.update>>;
  try {
    result = await bulkStatusAdminService.update(adminSession, {
      productIds: formData.getAll("productId"),
      status: formData.get("status"),
    });
  } catch {
    return { kind: "error", message: genericBulkStatusError };
  }

  if (!result.ok) {
    return { kind: "error", message: bulkStatusErrorMessage(result) };
  }

  const status = formData.get("status");
  if (status !== "DRAFT" && status !== "REVIEWED" && status !== "PUBLISHED") {
    return {
      kind: "error",
      message: "Trạng thái cập nhật không hợp lệ.",
    };
  }

  revalidatePath("/admin");
  return { kind: "success", updatedCount: result.updatedCount, status };
}

export async function bulkUpdateProductCollectionAction(
  _previousState: BulkProductCollectionActionState,
  formData: FormData,
): Promise<BulkProductCollectionActionState> {
  const admin = await readAdminSession();
  if (!admin.ok) return { kind: "error", message: admin.message };
  const adminSession = admin.session;

  const operation = formData.get("operation");
  const collectionSlug = formData.get("collectionSlug");

  let result: Awaited<ReturnType<typeof bulkCollectionAdminService.update>>;
  try {
    result = await bulkCollectionAdminService.update(adminSession, {
      productIds: formData.getAll("productId"),
      collectionSlug,
      operation,
    });
  } catch {
    return { kind: "error", message: genericBulkCollectionError };
  }

  if (!result.ok) {
    return {
      kind: "error",
      message:
        result.reason === "PRODUCT_NOT_FOUND"
          ? staleSelectionError
          : result.reason === "COLLECTION_NOT_FOUND"
            ? "Collection không còn tồn tại. Tải lại trang rồi thử lại."
            : result.reason === "COLLECTION_LIMIT_REACHED"
              ? "Có sản phẩm đã đạt giới hạn collection. Gỡ bớt collection trước khi thêm."
              : result.reason === "UNAVAILABLE"
                ? genericBulkCollectionError
                : "Lựa chọn hoặc collection không hợp lệ. Kiểm tra lại rồi thử lại.",
    };
  }

  if (
    typeof collectionSlug !== "string" ||
    (operation !== "add" && operation !== "remove")
  ) {
    return { kind: "error", message: genericBulkCollectionError };
  }

  revalidateDirectory();
  return {
    kind: "success",
    operation,
    collectionSlug,
    matchedCount: result.matchedCount,
    changedCount: result.changedCount,
  };
}

/**
 * Bulk catalog activation is two-phase: `catalog-prepare` returns the current server-computed
 * warning summary plus a proof bound to it, and `catalog-commit` re-validates that proof against
 * freshly read state. A drifted warning state comes back as a reconfirmation with a new proof and
 * zero writes, so the operator acknowledges what is true at commit time rather than at render
 * time. Disabling carries no publication risk and needs no handshake.
 */
export async function bulkProductCatalogAction(
  _previousState: BulkProductCatalogActionState,
  formData: FormData,
): Promise<BulkProductCatalogActionState> {
  const admin = await readAdminSession();
  if (!admin.ok) return { kind: "error", message: admin.message };
  const adminSession = admin.session;

  const intent = formData.get("intent");
  const productIds = formData.getAll("productId");

  try {
    if (intent === "catalog-prepare") {
      const result = await bulkCatalogAdminService.prepareEnable(adminSession, { productIds });
      if (!result.ok) {
        return {
          kind: "error",
          message:
            result.reason === "PRODUCT_NOT_AVAILABLE"
              ? staleSelectionError
              : "Lựa chọn không hợp lệ. Kiểm tra lại rồi thử lại.",
        };
      }
      return {
        kind: "confirm",
        productIds: result.productIds,
        zeroActiveCount: result.warningState.zeroActiveProductIds.length,
        compositeChildCount: result.warningState.compositeChildProductIds.length,
        proof: result.proof,
        expiresAtMs: result.expiresAtMs,
      };
    }

    if (intent === "catalog-commit") {
      const result = await bulkCatalogAdminService.commitEnable(adminSession, {
        productIds,
        proof: formData.get("proof"),
      });
      if (result.ok) {
        revalidateDirectory();
        return { kind: "success", operation: "enable", updatedCount: result.updatedCount };
      }
      if (result.reason === "RECONFIRM_REQUIRED") {
        return {
          kind: "reconfirm",
          productIds: [...result.productIds],
          zeroActiveCount: result.warningState.zeroActiveProductIds.length,
          compositeChildCount: result.warningState.compositeChildProductIds.length,
          proof: result.proof,
          expiresAtMs: result.expiresAtMs,
        };
      }
      return {
        kind: "error",
        message:
          result.reason === "PRODUCT_NOT_AVAILABLE"
            ? staleSelectionError
            : "Lựa chọn không hợp lệ. Kiểm tra lại rồi thử lại.",
      };
    }

    if (intent === "catalog-disable") {
      const result = await bulkCatalogAdminService.disable(adminSession, { productIds });
      if (!result.ok) {
        return {
          kind: "error",
          message:
            result.reason === "PRODUCT_NOT_AVAILABLE"
              ? staleSelectionError
              : "Lựa chọn không hợp lệ. Kiểm tra lại rồi thử lại.",
        };
      }
      revalidateDirectory();
      return { kind: "success", operation: "disable", updatedCount: result.updatedCount };
    }
  } catch {
    return { kind: "error", message: genericBulkCatalogError };
  }

  return { kind: "error", message: genericBulkCatalogError };
}

const genericBulkVariantError =
  "Không thể cập nhật biến thể lúc này. Danh sách đã chọn được giữ nguyên để bạn thử lại.";

export async function bulkProductVariantAction(
  _previousState: BulkProductVariantActionState,
  formData: FormData,
): Promise<BulkProductVariantActionState> {
  const admin = await readAdminSession();
  if (!admin.ok) return { kind: "error", message: admin.message };
  const adminSession = admin.session;

  const mode = formData.get("mode");
  const productIds = formData.getAll("productId");

  let result: Awaited<ReturnType<typeof bulkCatalogAdminService.updateVariantActivation>>;
  try {
    result = await bulkCatalogAdminService.updateVariantActivation(adminSession, {
      productIds,
      mode,
    });
  } catch {
    return { kind: "error", message: genericBulkVariantError };
  }

  if (!result.ok) {
    return {
      kind: "error",
      message:
        result.reason === "PRODUCT_NOT_AVAILABLE"
          ? staleSelectionError
          : "Lựa chọn hoặc thao tác không hợp lệ. Kiểm tra lại rồi thử lại.",
    };
  }

  revalidateDirectory();
  return {
    kind: "success",
    mode: result.mode,
    productCount: result.productCount,
    matchedVariantCount: result.matchedVariantCount,
    changedVariantCount: result.changedVariantCount,
  };
}
