import type { Metadata } from "next";
import Link from "next/link";
import { revalidatePath } from "next/cache";
import { notFound, redirect } from "next/navigation";

import { readAuthServerConfig } from "@/auth/config";
import { requireCurrentAdmin, requireCurrentAdminPage } from "@/auth/current-admin";
import { createCollectionDefinitionRepository } from "@/commerce/collection-definition-repository";
import {
  createProductContentAdminService,
  PRODUCT_CONTENT_LIMITS,
} from "@/commerce/product-content-admin";
import { createProductContentRepository } from "@/commerce/product-content-repository";
import { createProductCommerceAdminService } from "@/commerce/product-commerce-admin";
import { createProductCommerceRepository } from "@/commerce/product-commerce-repository";
import { AdminFormStatus } from "@/components/admin/admin-form-status";
import {
  ProductCommercePanel,
  type ProductCommerceActionState,
  type ProductCommerceVariantRow,
} from "@/components/admin/product-commerce-panel";
import { ProductEditorialForm } from "@/components/admin/product-editorial-form";
import { ProductMerchantFactsEditor } from "@/components/admin/product-merchant-facts-editor";
import { ProductSellingPolicyEditor } from "@/components/admin/product-selling-policy-editor";
import {
  ProductPancakeSource,
  type ProductPancakeCompositeParent,
  type ProductPancakeSourceVariant,
} from "@/components/admin/product-pancake-source";
import { ProductSlugEditor } from "@/components/admin/product-slug-editor";
import { createPromotionAdminRepository } from "@/commerce/promotion-admin-repository";
import { ProductPromotionsSummary } from "@/components/admin/product-promotions-summary";
import { prisma } from "@/db/prisma";

export const metadata: Metadata = {
  title: "Biên tập nội dung sản phẩm",
};

const repository = createProductContentRepository(prisma);
const collectionRepository = createCollectionDefinitionRepository(prisma);
const productCommerceRepository = createProductCommerceRepository(prisma);
const promotionRepository = createPromotionAdminRepository(prisma);
const productCommerceAdminService = createProductCommerceAdminService({
  setVariantActivation: productCommerceRepository.setVariantActivation,
  readCatalogEnableWarningState: productCommerceRepository.readCatalogEnableWarningState,
  commitCatalogEnable: productCommerceRepository.commitCatalogEnable,
  disableCatalog: productCommerceRepository.disableCatalog,
  activateProductAndStockedVariants: productCommerceRepository.activateProductAndStockedVariants,
  readConfirmationSecret: () => readAuthServerConfig().secret,
  nowMs: () => Date.now(),
});
const adminService = createProductContentAdminService({
  productExists: repository.productExists,
  resolveCollectionSlugs: collectionRepository.resolveMembershipSlugs,
  saveContent: repository.saveContent,
});

function queryValue(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : value?.[0];
}

/**
 * B5: a refused publish gets its own query code so the editor is told which precondition failed.
 * A single "không thể lưu" would send an operator hunting through a form that is in fact valid —
 * the copy is complete and within bounds, it just may not be published.
 */
const PRODUCT_CONTENT_ERROR_CODES = {
  SEO_TITLE_REQUIRED: "seo-title",
  SEO_DESCRIPTION_REQUIRED: "seo-description",
  SEO_PAIR_CONFLICT: "seo-pair",
  INVALID_INPUT: "invalid",
  COLLECTION_NOT_FOUND: "invalid",
} as const;

const PRODUCT_CONTENT_ERROR_MESSAGES: Record<string, string> = {
  "seo-title": "Cần có SEO title trước khi chuyển sang PUBLISHED. Nội dung chưa được lưu.",
  "seo-description":
    "Cần có SEO description trước khi chuyển sang PUBLISHED. Nội dung chưa được lưu.",
  "seo-pair":
    "Cặp SEO title + description này đã thuộc về một sản phẩm đã publish. Sửa một trong hai trường rồi thử lại. Nội dung chưa được lưu.",
  invalid: "Không thể lưu. Kiểm tra độ dài và định dạng các trường rồi thử lại.",
};

function productCommerceError(message: string): ProductCommerceActionState {
  return { kind: "error", message };
}

type ProductEditorPageProps = {
  params: Promise<{ productId: string }>;
  searchParams: Promise<{
    saved?: string | string[];
    error?: string | string[];
    slugSaved?: string | string[];
    slugError?: string | string[];
    variantSaved?: string | string[];
    variantError?: string | string[];
    merchantSaved?: string | string[];
    merchantError?: string | string[];
    policySaved?: string | string[];
    policyError?: string | string[];
  }>;
};

export default async function ProductEditorPage({ params, searchParams }: ProductEditorPageProps) {
  const { productId } = await params;
  if (
    productId.length === 0 ||
    productId.length > PRODUCT_CONTENT_LIMITS.productId ||
    productId !== productId.trim()
  ) {
    notFound();
  }

  await requireCurrentAdminPage();
  const product = await repository.findForEditor(productId);
  if (!product) {
    notFound();
  }

  const persistedProductId = product.id;
  const persistedProductSlug = product.slug;
  const editorPath = `/admin/products/${persistedProductId}`;

  async function saveProductContent(formData: FormData) {
    "use server";

    const adminSession = await requireCurrentAdmin();
    const result = await adminService.update(adminSession, {
      productId: persistedProductId,
      status: formData.get("status"),
      editorialDescription: formData.get("editorialDescription"),
      careInstructions: formData.get("careInstructions"),
      sizeGuide: formData.get("sizeGuide"),
      seoTitle: formData.get("seoTitle"),
      seoDescription: formData.get("seoDescription"),
      collectionSlugs: formData
        .getAll("collectionSlugs")
        .filter((value): value is string => typeof value === "string")
        .join(", "),
    });

    if (!result.ok) {
      if (result.reason === "PRODUCT_NOT_FOUND") {
        redirect("/admin");
      }
      redirect(`${editorPath}?error=${PRODUCT_CONTENT_ERROR_CODES[result.reason]}`);
    }

    revalidatePath(editorPath);
    revalidatePath("/admin");
    revalidatePath("/shop");
    redirect(`${editorPath}?saved=1`);
  }

  async function setWebsiteVariantActivation(formData: FormData) {
    "use server";

    const adminSession = await requireCurrentAdmin();
    const activateVariantId = formData.get("activateVariantId");
    const deactivateVariantId = formData.get("deactivateVariantId");
    const bulkState = formData.get("bulkState");

    const hasActivate = typeof activateVariantId === "string";
    const hasDeactivate = typeof deactivateVariantId === "string";
    const hasBulk = bulkState === "true" || bulkState === "false";
    if (Number(hasActivate) + Number(hasDeactivate) + Number(hasBulk) !== 1) {
      redirect(`${editorPath}?variantError=invalid`);
    }

    let variantIds: unknown[];
    let isActive: boolean;
    if (hasActivate) {
      variantIds = [activateVariantId];
      isActive = true;
    } else if (hasDeactivate) {
      variantIds = [deactivateVariantId];
      isActive = false;
    } else {
      variantIds = formData.getAll("variantId");
      isActive = bulkState === "true";
    }

    const result = await productCommerceAdminService.setVariantActivation(
      adminSession,
      persistedProductId,
      { variantIds, isActive },
    );
    if (!result.ok) {
      redirect(
        `${editorPath}?variantError=${
          result.reason === "VARIANT_NOT_AVAILABLE" ? "unavailable" : "invalid"
        }`,
      );
    }

    revalidatePath(editorPath);
    revalidatePath("/admin");
    revalidatePath("/shop");
    revalidatePath(`/shop/${persistedProductSlug}`);
    redirect(`${editorPath}?variantSaved=1`);
  }

  async function manageProductCommerce(
    _previousState: ProductCommerceActionState,
    formData: FormData,
  ): Promise<ProductCommerceActionState> {
    "use server";

    const adminSession = await requireCurrentAdmin();
    const intent = formData.get("intent");

    if (intent === "catalog-prepare") {
      const result = await productCommerceAdminService.prepareCatalogEnable(
        adminSession,
        persistedProductId,
      );
      if (!result.ok) {
        return productCommerceError(
          result.reason === "PRODUCT_NOT_AVAILABLE"
            ? "Sản phẩm không còn khả dụng."
            : "Không thể chuẩn bị xác nhận bật catalog.",
        );
      }
      return {
        kind: "catalog-confirm",
        warningState: result.warningState,
        proof: result.proof,
        expiresAtMs: result.expiresAtMs,
      };
    }

    if (intent === "catalog-commit") {
      const result = await productCommerceAdminService.commitCatalogEnable(
        adminSession,
        persistedProductId,
        { proof: formData.get("proof") },
      );
      if (result.ok) {
        revalidatePath(editorPath);
        revalidatePath("/admin");
        revalidatePath("/shop");
        revalidatePath(`/shop/${persistedProductSlug}`);
        return { kind: "success", operation: "catalog-enable" };
      }
      if (result.reason === "RECONFIRM_REQUIRED") {
        revalidatePath(editorPath);
        return {
          kind: "catalog-reconfirm",
          warningState: result.warningState,
          proof: result.proof,
          expiresAtMs: result.expiresAtMs,
        };
      }
      return productCommerceError("Sản phẩm không còn khả dụng.");
    }

    if (intent === "catalog-disable") {
      const result = await productCommerceAdminService.disableCatalog(
        adminSession,
        persistedProductId,
      );
      if (!result.ok) {
        return productCommerceError(
          result.reason === "PRODUCT_NOT_AVAILABLE"
            ? "Sản phẩm không còn khả dụng."
            : "Không thể tắt catalog.",
        );
      }
      revalidatePath(editorPath);
      revalidatePath("/admin");
      revalidatePath("/shop");
      revalidatePath(`/shop/${persistedProductSlug}`);
      return { kind: "success", operation: "catalog-disable" };
    }

    if (intent === "quick-activate") {
      const result = await productCommerceAdminService.activateProductAndStockedVariants(
        adminSession,
        persistedProductId,
      );
      if (!result.ok) {
        revalidatePath(editorPath);
        return productCommerceError(
          result.reason === "COMPOSITE_CHILD"
            ? "Sản phẩm hiện là thành phần của set/composite. Thao tác đã bị hủy và không có dữ liệu nào được thay đổi."
            : "Sản phẩm không còn khả dụng.",
        );
      }
      revalidatePath(editorPath);
      revalidatePath("/admin");
      revalidatePath("/shop");
      revalidatePath(`/shop/${persistedProductSlug}`);
      return {
        kind: "success",
        operation: "quick-activate",
        activatedVariantCount: result.activatedVariantCount,
      };
    }

    return productCommerceError("Thao tác website commerce không hợp lệ.");
  }

  const compositeParents: ProductPancakeCompositeParent[] = product.variants
    .filter((variant) => variant.compositeComponents.length > 0)
    .map((variant) => ({
      id: variant.id,
      sku: variant.sku,
      color: variant.color,
      size: variant.size,
      components: variant.compositeComponents.map((edge) => ({
        quantity: edge.quantity,
        variant: edge.componentVariant,
        stock: edge.componentVariant.warehouseStocks.reduce((acc, ws) => acc + ws.quantity, 0),
      })),
    }));

  const definedCollections = await collectionRepository.listForAdmin(100);
  const assignedSlugs = new Set(product.content?.collectionSlugs ?? []);
  const definedSlugs = new Set(definedCollections.map((collection) => collection.slug));
  const collectionChoices = [
    ...definedCollections.map((collection) => ({
      slug: collection.slug,
      title: collection.title,
      isPublished: collection.isPublished,
      checked: assignedSlugs.has(collection.slug),
      missing: false,
    })),
    ...[...assignedSlugs]
      .filter((slug) => !definedSlugs.has(slug))
      .map((slug) => ({ slug, title: slug, isPublished: false, checked: true, missing: true })),
  ];

  const commerceVariants: ProductCommerceVariantRow[] = product.variants
    .filter((variant) => variant.isPresent)
    .map((variant) => {
      const contexts: ProductCommerceVariantRow["contexts"] = [];
      if (variant.compositeComponents.length > 0) contexts.push("Set cha");
      if (variant.compositeParents.length > 0) contexts.push("Thành phần set");
      if (contexts.length === 0) contexts.push("Thường");
      return {
        id: variant.id,
        label:
          variant.sku ||
          [variant.color, variant.size].filter(Boolean).join(" / ") ||
          variant.id,
        sku: variant.sku,
        color: variant.color,
        size: variant.size,
        stock: variant.warehouseStocks.reduce((sum, warehouse) => sum + warehouse.quantity, 0),
        isActive: variant.isActive,
        contexts,
      };
    });
  const quickActionEligible = !product.variants.some(
    (variant) => variant.compositeParents.length > 0,
  );

  // B5: a draft may hold copy a published product already owns, and the editor has to see that
  // while it is still a draft rather than at publish time. This is the read-only half of the same
  // contract the publish path enforces, so a warning and a block can never disagree.
  const seoPairConflictSlugs = await repository.findPublishedPairConflicts({
    productId: persistedProductId,
    seoTitle: product.content?.seoTitle ?? null,
    seoDescription: product.content?.seoDescription ?? null,
  });

  const query = await searchParams;
  const saved = queryValue(query.saved) === "1";
  const rawContentError = queryValue(query.error);
  const contentError =
    rawContentError !== undefined && rawContentError in PRODUCT_CONTENT_ERROR_MESSAGES
      ? rawContentError
      : undefined;
  const formStatus = contentError ? "error" : saved ? "success" : null;
  const slugSaved = queryValue(query.slugSaved) === "1";
  const rawSlugError = queryValue(query.slugError);
  const slugError =
    rawSlugError === "invalid" || rawSlugError === "unavailable" ? rawSlugError : null;
  const variantSaved = queryValue(query.variantSaved) === "1";
  const rawVariantError = queryValue(query.variantError);
  const variantError =
    rawVariantError === "invalid" || rawVariantError === "unavailable" ? rawVariantError : null;
  const variantStatus = variantError ? "error" : variantSaved ? "success" : null;
  const merchantSaved = queryValue(query.merchantSaved) === "1";
  const merchantError = queryValue(query.merchantError) === "1";
  // I3 — the refusal reason travels in the query so the editor can name which precondition failed.
  // The boundary's reasons are a closed set and carry no operator input, so echoing one is safe.
  const policySaved = queryValue(query.policySaved) === "1";
  const policyError = queryValue(query.policyError);
  const variantErrorMessage =
    variantError === "unavailable"
      ? "Không thể cập nhật. Một hoặc nhiều biến thể không còn khả dụng cho sản phẩm này."
      : "Không thể cập nhật. Dữ liệu biến thể không hợp lệ.";

  const allImages = new Set<string>();
  if (product.primaryImageUrl) {
    allImages.add(product.primaryImageUrl);
  }
  for (const variant of product.variants) {
    if (Array.isArray(variant.pancakeImageUrls)) {
      for (const image of variant.pancakeImageUrls) {
        if (typeof image === "string" && image.startsWith("http")) {
          allImages.add(image);
        }
      }
    }
  }
  const imageUrls = Array.from(allImages);

  const sourceVariants: ProductPancakeSourceVariant[] = product.variants.map((variant) => ({
    id: variant.id,
    sku: variant.sku,
    color: variant.color,
    size: variant.size,
    pancakeRetailPrice: variant.pancakeRetailPrice,
    pancakeRetailPriceAfterDiscount: variant.pancakeRetailPriceAfterDiscount,
    stock: variant.warehouseStocks.reduce((sum, warehouse) => sum + warehouse.quantity, 0),
    isActive: variant.isActive,
  }));

  const activeVariantCount = commerceVariants.filter((variant) => variant.isActive).length;
  const positiveStockVariantCount = commerceVariants.filter((variant) => variant.stock > 0).length;
  const totalStock = commerceVariants.reduce((sum, variant) => sum + variant.stock, 0);

  const relatedCampaigns = await promotionRepository.listRelatedCampaignsForProduct({
    productId: persistedProductId,
    variantIds: product.variants.map((variant) => variant.id),
  });

  return (
    <div className="mx-auto max-w-6xl">
      <div className="border-b border-black/20 pb-8">
        <Link
          className="text-xs font-semibold uppercase tracking-[0.14em] text-black/60 underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-4"
          href="/admin"
        >
          ← Danh sách sản phẩm
        </Link>
        <p className="eyebrow mt-8">Biên tập sản phẩm</p>
        <h1 className="mt-3 max-w-4xl font-serif text-5xl leading-[0.95] tracking-[-0.05em] md:text-7xl">
          {product.name}
        </h1>
        <p className="mt-4 text-sm text-black/60">/{product.slug}</p>
      </div>

      <AdminFormStatus
        kind={formStatus}
        errorMessage={
          contentError
            ? PRODUCT_CONTENT_ERROR_MESSAGES[contentError]
            : PRODUCT_CONTENT_ERROR_MESSAGES.invalid
        }
      />
      <AdminFormStatus
        kind={variantStatus}
        successMessage="Đã cập nhật trạng thái biến thể website."
        errorMessage={variantErrorMessage}
      />

      <section aria-labelledby="product-operational-summary-heading" className="mt-8">
        <h2 id="product-operational-summary-heading" className="sr-only">
          Tóm tắt vận hành sản phẩm
        </h2>
        <dl className="grid gap-3 border border-black/20 bg-black/[0.02] p-4 text-xs sm:grid-cols-3 lg:grid-cols-6">
          <div>
            <dt className="text-black/55">Catalog</dt>
            <dd className="mt-1 font-semibold">{product.isActive ? "Đang bật" : "Đang tắt"}</dd>
          </div>
          <div>
            <dt className="text-black/55">Editorial</dt>
            <dd className="mt-1 font-semibold">{product.content?.status ?? "DRAFT"}</dd>
          </div>
          <div>
            <dt className="text-black/55">Variants</dt>
            <dd className="mt-1 font-semibold">
              {activeVariantCount} / {commerceVariants.length} active
            </dd>
          </div>
          <div>
            <dt className="text-black/55">Có hàng</dt>
            <dd className="mt-1 font-semibold">{positiveStockVariantCount}</dd>
          </div>
          <div>
            <dt className="text-black/55">Tổng kho</dt>
            <dd className="mt-1 font-semibold">{totalStock}</dd>
          </div>
          <div>
            <dt className="text-black/55">Collection</dt>
            <dd className="mt-1 font-semibold">{assignedSlugs.size}</dd>
          </div>
        </dl>
      </section>

      <ProductCommercePanel
        commerceAction={manageProductCommerce}
        collectionCount={assignedSlugs.size}
        productIsActive={product.isActive}
        productName={product.name}
        quickActionEligible={quickActionEligible}
        variantAction={setWebsiteVariantActivation}
        variants={commerceVariants}
      />

      <ProductPromotionsSummary campaigns={relatedCampaigns} />

      <ProductEditorialForm
        action={saveProductContent}
        collectionChoices={collectionChoices}
        content={product.content}
        seoPairConflictSlugs={seoPairConflictSlugs}
      />

      <ProductMerchantFactsEditor
        editorPath={editorPath}
        error={merchantError}
        productId={persistedProductId}
        saved={merchantSaved}
      />

      <ProductSellingPolicyEditor
        editorPath={editorPath}
        error={policyError}
        productId={persistedProductId}
        saved={policySaved}
      />

      <ProductSlugEditor
        productId={persistedProductId}
        currentSlug={product.slug}
        editorPath={editorPath}
        saved={slugSaved}
        error={slugError}
      />

      <ProductPancakeSource
        compositeParents={compositeParents}
        imageUrls={imageUrls}
        productName={product.name}
        sourceDescription={product.sourceDescription}
        variants={sourceVariants}
      />
    </div>
  );
}
