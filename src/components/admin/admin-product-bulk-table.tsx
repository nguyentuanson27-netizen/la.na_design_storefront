"use client";

import Image from "next/image";
import Link from "next/link";
import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";

import {
  bulkProductCatalogAction,
  bulkProductVariantAction,
  bulkUpdateProductCollectionAction,
  bulkUpdateProductStatusAction,
  type BulkProductCatalogActionState,
  type BulkProductCollectionActionState,
  type BulkProductStatusActionState,
  type BulkProductVariantActionState,
} from "@/app/admin/actions";
import type { BulkVariantActivationMode } from "@/commerce/product-commerce-repository";
import type { ProductContentStatus } from "@/commerce/product-content-admin";

const statusLabels: Record<ProductContentStatus, string> = {
  DRAFT: "Nháp",
  REVIEWED: "Đã duyệt",
  PUBLISHED: "Đã xuất bản",
};

const statusStyles: Record<ProductContentStatus, string> = {
  DRAFT: "bg-black/10 text-black/70",
  REVIEWED: "bg-amber-100 text-amber-900",
  PUBLISHED: "bg-emerald-100 text-emerald-900",
};

const VARIANT_OPERATION_PREFIX = "variants-";

/**
 * Variant operations are derived from the wire modes rather than spelled out again, so a mode added
 * to `BulkVariantActivationMode` fails to compile here until it has a label, a button and a
 * confirmation question.
 */
type VariantOperation = `${typeof VARIANT_OPERATION_PREFIX}${BulkVariantActivationMode}`;

type BulkOperation =
  | "status"
  | "collection-add"
  | "collection-remove"
  | "catalog-enable"
  | "catalog-disable"
  | VariantOperation;

const operationLabels = {
  status: "Trạng thái nội dung",
  "collection-add": "Thêm vào collection",
  "collection-remove": "Gỡ khỏi collection",
  "catalog-enable": "Bật catalog",
  "catalog-disable": "Tắt catalog",
  "variants-enable-all": "Kích hoạt tất cả biến thể",
  "variants-enable-stocked": "Kích hoạt biến thể có hàng",
  "variants-disable-all": "Tắt tất cả biến thể",
} as const satisfies Record<BulkOperation, string>;

/** Single source of the dropdown's contents and its order. */
const BULK_OPERATIONS = Object.keys(operationLabels) as readonly BulkOperation[];

/**
 * Sound by construction: every `BulkOperation` carrying the prefix is a `VariantOperation`, whose
 * remainder is exactly a `BulkVariantActivationMode` — TypeScript just cannot narrow a sliced
 * template literal.
 */
function variantModeOf(operation: BulkOperation): BulkVariantActivationMode | null {
  return operation.startsWith(VARIANT_OPERATION_PREFIX)
    ? (operation.slice(VARIANT_OPERATION_PREFIX.length) as BulkVariantActivationMode)
    : null;
}

const initialStatusState: BulkProductStatusActionState = { kind: "idle" };
const initialCollectionState: BulkProductCollectionActionState = { kind: "idle" };
const initialCatalogState: BulkProductCatalogActionState = { kind: "idle" };
const initialVariantState: BulkProductVariantActionState = { kind: "idle" };

const genericBulkStatusError =
  "Không thể cập nhật trạng thái lúc này. Danh sách đã chọn được giữ nguyên để bạn thử lại.";
const genericBulkError =
  "Không thể thực hiện thao tác lúc này. Danh sách đã chọn được giữ nguyên để bạn thử lại.";

type AdminProductBulkTableRow = {
  id: string;
  name: string;
  slug: string;
  primaryImageUrl: string | null;
  isActive: boolean;
  status: ProductContentStatus;
  collections: Array<{
    slug: string;
    label: string;
    href: string;
  }>;
  price: string | null;
  variantCount: number;
  activeVariantCount: number;
  stockedInactiveCount: number;
  missingImage: boolean;
};

type AdminCollectionChoice = {
  slug: string;
  title: string;
};

type AdminProductBulkTableProps = {
  products: AdminProductBulkTableRow[];
  collections: AdminCollectionChoice[];
};

type Feedback = {
  message: string;
  tone: "status" | "alert";
};

export function AdminProductBulkTable({ products, collections }: AdminProductBulkTableProps) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [operation, setOperation] = useState<BulkOperation>("status");
  const [targetStatus, setTargetStatus] = useState<ProductContentStatus>("REVIEWED");
  const [targetCollection, setTargetCollection] = useState<string>(
    () => collections[0]?.slug ?? "",
  );
  const [confirming, setConfirming] = useState(false);
  const [statusState, setStatusState] = useState<BulkProductStatusActionState>(initialStatusState);
  const [collectionState, setCollectionState] =
    useState<BulkProductCollectionActionState>(initialCollectionState);
  const [catalogState, setCatalogState] =
    useState<BulkProductCatalogActionState>(initialCatalogState);
  const [variantState, setVariantState] =
    useState<BulkProductVariantActionState>(initialVariantState);
  const [isPending, setIsPending] = useState(false);
  const selectAllRef = useRef<HTMLInputElement>(null);
  const feedbackRef = useRef<HTMLDivElement>(null);

  const selectedCount = selectedIds.size;
  const allSelected = products.length > 0 && selectedCount === products.length;
  const partlySelected = selectedCount > 0 && selectedCount < products.length;
  const collectionTitles = useMemo(
    () => new Map(collections.map((collection) => [collection.slug, collection.title])),
    [collections],
  );
  const catalogConfirmation =
    catalogState.kind === "confirm" || catalogState.kind === "reconfirm" ? catalogState : null;

  useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate = partlySelected;
    }
  }, [partlySelected]);

  /**
   * Any change to what the operation would touch invalidates a pending confirmation — including a
   * prepared catalog proof, which is bound to the exact selection it was issued for.
   */
  function resetConfirmation() {
    setConfirming(false);
    setCatalogState((current) =>
      current.kind === "confirm" || current.kind === "reconfirm" ? initialCatalogState : current,
    );
  }

  function toggleProduct(productId: string, checked: boolean) {
    resetConfirmation();
    setSelectedIds((current) => {
      const next = new Set(current);
      if (checked) next.add(productId);
      else next.delete(productId);
      return next;
    });
  }

  function toggleCurrentPage(checked: boolean) {
    resetConfirmation();
    setSelectedIds(checked ? new Set(products.map((product) => product.id)) : new Set());
  }

  function clearSelection() {
    setSelectedIds(new Set());
    resetConfirmation();
  }

  /** Clears stale feedback without discarding a live catalog confirmation. */
  function clearFeedback() {
    setStatusState(initialStatusState);
    setCollectionState(initialCollectionState);
    setVariantState(initialVariantState);
    setCatalogState((current) =>
      current.kind === "success" || current.kind === "error" ? initialCatalogState : current,
    );
  }

  function selectionFormData(extra: Readonly<Record<string, string>> = {}): FormData {
    const formData = new FormData();
    for (const productId of selectedIds) formData.append("productId", productId);
    for (const [key, value] of Object.entries(extra)) formData.append(key, value);
    return formData;
  }

  async function runStatusUpdate(formData: FormData) {
    const result = await bulkUpdateProductStatusAction(initialStatusState, formData);
    setStatusState(result);
    if (result.kind === "success") clearSelection();
  }

  async function runCollectionUpdate(operationName: "add" | "remove") {
    const result = await bulkUpdateProductCollectionAction(
      initialCollectionState,
      selectionFormData({ operation: operationName, collectionSlug: targetCollection }),
    );
    setCollectionState(result);
    if (result.kind === "success") clearSelection();
  }

  async function runCatalogIntent(intent: string, extra: Readonly<Record<string, string>> = {}) {
    const formData =
      intent === "catalog-commit" && catalogConfirmation
        ? (() => {
            const commitData = new FormData();
            for (const productId of catalogConfirmation.productIds) {
              commitData.append("productId", productId);
            }
            commitData.append("intent", intent);
            commitData.append("proof", catalogConfirmation.proof);
            return commitData;
          })()
        : selectionFormData({ intent, ...extra });

    const result = await bulkProductCatalogAction(initialCatalogState, formData);
    setCatalogState(result);
    if (result.kind === "success") clearSelection();
  }

  async function runVariantUpdate(mode: BulkVariantActivationMode) {
    const result = await bulkProductVariantAction(
      initialVariantState,
      selectionFormData({ mode }),
    );
    setVariantState(result);
    if (result.kind === "success") clearSelection();
  }

  async function submitBulkOperation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (selectedCount === 0 || isPending) return;

    const formData = new FormData(event.currentTarget);
    const variantMode = variantModeOf(operation);
    setIsPending(true);
    clearFeedback();
    try {
      if (operation === "status") {
        await runStatusUpdate(formData);
      } else if (operation === "collection-add" || operation === "collection-remove") {
        await runCollectionUpdate(operation === "collection-add" ? "add" : "remove");
      } else if (operation === "catalog-disable") {
        await runCatalogIntent("catalog-disable");
      } else if (operation === "catalog-enable") {
        await runCatalogIntent("catalog-commit");
      } else if (variantMode) {
        await runVariantUpdate(variantMode);
      }
    } catch {
      if (operation === "status") {
        setStatusState({ kind: "error", message: genericBulkStatusError });
      } else if (needsCollection) {
        setCollectionState({ kind: "error", message: genericBulkError });
      } else if (variantMode) {
        setVariantState({ kind: "error", message: genericBulkError });
      } else {
        setCatalogState({ kind: "error", message: genericBulkError });
      }
    } finally {
      setIsPending(false);
      requestAnimationFrame(() => feedbackRef.current?.focus());
    }
  }

  async function prepareCatalogEnable() {
    if (selectedCount === 0 || isPending) return;
    setIsPending(true);
    clearFeedback();
    try {
      await runCatalogIntent("catalog-prepare");
    } catch {
      setCatalogState({ kind: "error", message: genericBulkError });
    } finally {
      setIsPending(false);
    }
  }

  const feedback = useMemo<Feedback | null>(() => {
    if (statusState.kind === "success") {
      return {
        tone: "status",
        message: `Đã cập nhật ${statusState.updatedCount} sản phẩm sang ${statusLabels[statusState.status]}.`,
      };
    }
    if (statusState.kind === "error") return { tone: "alert", message: statusState.message };

    if (collectionState.kind === "success") {
      const title = collectionTitles.get(collectionState.collectionSlug) ?? collectionState.collectionSlug;
      const verb = collectionState.operation === "add" ? "Đã thêm" : "Đã gỡ";
      const preposition = collectionState.operation === "add" ? "cho" : "khỏi";
      return {
        tone: "status",
        message: `${verb} ${title} ${preposition} ${collectionState.matchedCount} sản phẩm; ${collectionState.changedCount} sản phẩm thay đổi.`,
      };
    }
    if (collectionState.kind === "error") return { tone: "alert", message: collectionState.message };

    if (catalogState.kind === "success") {
      return {
        tone: "status",
        message:
          catalogState.operation === "enable"
            ? `Đã bật catalog cho ${catalogState.updatedCount} sản phẩm.`
            : `Đã tắt catalog cho ${catalogState.updatedCount} sản phẩm.`,
      };
    }
    if (catalogState.kind === "reconfirm") {
      return {
        tone: "alert",
        message: "Trạng thái cảnh báo đã thay đổi. Không có sản phẩm nào được cập nhật. Vui lòng xác nhận lại.",
      };
    }
    if (catalogState.kind === "error") return { tone: "alert", message: catalogState.message };

    if (variantState.kind === "success") {
      const scope =
        variantState.mode === "enable-all"
          ? `Đã kích hoạt ${variantState.matchedVariantCount} biến thể`
          : variantState.mode === "enable-stocked"
            ? `Đã kích hoạt ${variantState.matchedVariantCount} biến thể có hàng`
            : `Đã tắt ${variantState.matchedVariantCount} biến thể`;
      return {
        tone: "status",
        message: `${scope} cho ${variantState.productCount} sản phẩm; ${variantState.changedVariantCount} biến thể thay đổi.`,
      };
    }
    if (variantState.kind === "error") return { tone: "alert", message: variantState.message };

    return null;
  }, [statusState, collectionState, catalogState, variantState, collectionTitles]);

  const collectionTitle = collectionTitles.get(targetCollection) ?? targetCollection;
  const primaryLabels: Record<BulkOperation, string> = {
    status: `Cập nhật ${selectedCount} sản phẩm`,
    "collection-add": `Thêm collection cho ${selectedCount} sản phẩm`,
    "collection-remove": `Gỡ collection khỏi ${selectedCount} sản phẩm`,
    "catalog-enable": `Bật catalog cho ${selectedCount} sản phẩm`,
    "catalog-disable": `Tắt catalog cho ${selectedCount} sản phẩm`,
    "variants-enable-all": `Kích hoạt tất cả biến thể cho ${selectedCount} sản phẩm`,
    "variants-enable-stocked": `Kích hoạt biến thể có hàng cho ${selectedCount} sản phẩm`,
    "variants-disable-all": `Tắt tất cả biến thể cho ${selectedCount} sản phẩm`,
  };
  const confirmQuestions: Record<BulkOperation, string> = {
    status: `Cập nhật ${selectedCount} sản phẩm sang ${statusLabels[targetStatus]}?`,
    "collection-add": `Thêm ${collectionTitle} cho ${selectedCount} sản phẩm?`,
    "collection-remove": `Gỡ ${collectionTitle} khỏi ${selectedCount} sản phẩm?`,
    "catalog-enable": `Bật catalog cho ${catalogConfirmation?.productIds.length ?? selectedCount} sản phẩm?`,
    "catalog-disable": `Tắt catalog cho ${selectedCount} sản phẩm?`,
    "variants-enable-all": `Kích hoạt tất cả biến thể cho ${selectedCount} sản phẩm đã chọn?`,
    "variants-enable-stocked": `Kích hoạt các biến thể có hàng cho ${selectedCount} sản phẩm đã chọn?`,
    "variants-disable-all": `Tắt tất cả biến thể cho ${selectedCount} sản phẩm đã chọn?`,
  };
  const needsCollection = operation === "collection-add" || operation === "collection-remove";
  const primaryDisabled = isPending || (needsCollection && targetCollection === "");
  const showConfirmation = operation === "catalog-enable" ? catalogConfirmation !== null : confirming;

  return (
    <form onSubmit={submitBulkOperation}>
      <div
        ref={feedbackRef}
        aria-atomic={feedback ? "true" : undefined}
        className="min-h-0 focus-visible:outline-2 focus-visible:outline-offset-4"
        role={feedback?.tone === "alert" ? "alert" : feedback?.tone === "status" ? "status" : undefined}
        tabIndex={-1}
      >
        {feedback ? (
          <p className="mb-4 border-l-2 border-black pl-4 text-sm font-semibold">{feedback.message}</p>
        ) : null}
      </div>

      {selectedCount > 0 ? (
        <div className="sticky top-0 z-20 mb-3 border border-black bg-[var(--background)] p-3 shadow-sm">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
            <p className="text-sm font-semibold" aria-live="polite">
              Đã chọn {selectedCount} sản phẩm
            </p>

            <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:flex-wrap">
              <label className="block min-w-44">
                <span className="text-[0.65rem] font-semibold uppercase tracking-[0.13em]">
                  Thao tác
                </span>
                <select
                  className="mt-1 min-h-11 w-full border border-black/25 bg-white px-3 py-2 text-sm outline-none focus-visible:border-black focus-visible:outline-2 focus-visible:outline-offset-2"
                  disabled={isPending}
                  onChange={(event) => {
                    setOperation(event.target.value as BulkOperation);
                    resetConfirmation();
                  }}
                  value={operation}
                >
                  {BULK_OPERATIONS.map((value) => (
                    <option key={value} value={value}>
                      {operationLabels[value]}
                    </option>
                  ))}
                </select>
              </label>

              {operation === "status" ? (
                <label className="block min-w-44">
                  <span className="text-[0.65rem] font-semibold uppercase tracking-[0.13em]">
                    Trạng thái mới
                  </span>
                  <select
                    className="mt-1 min-h-11 w-full border border-black/25 bg-white px-3 py-2 text-sm outline-none focus-visible:border-black focus-visible:outline-2 focus-visible:outline-offset-2"
                    disabled={isPending}
                    name="status"
                    onChange={(event) => {
                      setTargetStatus(event.target.value as ProductContentStatus);
                      resetConfirmation();
                    }}
                    value={targetStatus}
                  >
                    <option value="DRAFT">{statusLabels.DRAFT}</option>
                    <option value="REVIEWED">{statusLabels.REVIEWED}</option>
                    <option value="PUBLISHED">{statusLabels.PUBLISHED}</option>
                  </select>
                </label>
              ) : null}

              {needsCollection ? (
                <label className="block min-w-44">
                  <span className="text-[0.65rem] font-semibold uppercase tracking-[0.13em]">
                    Collection
                  </span>
                  <select
                    className="mt-1 min-h-11 w-full border border-black/25 bg-white px-3 py-2 text-sm outline-none focus-visible:border-black focus-visible:outline-2 focus-visible:outline-offset-2"
                    disabled={isPending || collections.length === 0}
                    onChange={(event) => {
                      setTargetCollection(event.target.value);
                      resetConfirmation();
                    }}
                    value={targetCollection}
                  >
                    {collections.length === 0 ? (
                      <option value="">Chưa có collection</option>
                    ) : (
                      collections.map((collection) => (
                        <option key={collection.slug} value={collection.slug}>
                          {collection.title}
                        </option>
                      ))
                    )}
                  </select>
                </label>
              ) : null}

              {!showConfirmation ? (
                <button
                  className="inline-flex min-h-11 items-center justify-center border border-black bg-black px-4 py-2 text-xs font-semibold uppercase tracking-[0.12em] text-white transition-colors hover:bg-white hover:text-black focus-visible:outline-2 focus-visible:outline-offset-4 disabled:cursor-not-allowed disabled:opacity-50"
                  disabled={primaryDisabled}
                  onClick={() => {
                    if (operation === "catalog-enable") void prepareCatalogEnable();
                    else setConfirming(true);
                  }}
                  type="button"
                >
                  {primaryLabels[operation]}
                </button>
              ) : (
                <div
                  className="flex flex-col gap-2"
                  role="group"
                  aria-label="Xác nhận thao tác hàng loạt"
                >
                  {catalogConfirmation ? (
                    <ul className="max-w-md list-none text-sm leading-6">
                      <li>
                        {catalogConfirmation.zeroActiveCount}/
                        {catalogConfirmation.productIds.length} sản phẩm hiện không có biến thể hoạt
                        động.
                      </li>
                      <li>
                        {catalogConfirmation.compositeChildCount}/
                        {catalogConfirmation.productIds.length} sản phẩm đang là thành phần
                        set/composite và sẽ được mở catalog riêng.
                      </li>
                      <li className="font-semibold">Bật catalog không tự kích hoạt biến thể.</li>
                    </ul>
                  ) : null}
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm">{confirmQuestions[operation]}</span>
                    <button
                      className="inline-flex min-h-11 items-center justify-center border border-black bg-black px-4 py-2 text-xs font-semibold uppercase tracking-[0.12em] text-white focus-visible:outline-2 focus-visible:outline-offset-4 disabled:cursor-not-allowed disabled:opacity-50"
                      disabled={isPending}
                      type="submit"
                    >
                      {isPending ? "Đang cập nhật…" : "Xác nhận"}
                    </button>
                    <button
                      className="inline-flex min-h-11 items-center justify-center px-3 py-2 text-xs font-semibold uppercase tracking-[0.12em] underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-4"
                      disabled={isPending}
                      onClick={resetConfirmation}
                      type="button"
                    >
                      Hủy
                    </button>
                  </div>
                </div>
              )}

              <button
                className="inline-flex min-h-11 items-center justify-center px-3 py-2 text-xs font-semibold uppercase tracking-[0.12em] underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-4 disabled:opacity-50"
                disabled={isPending}
                onClick={clearSelection}
                type="button"
              >
                Bỏ chọn
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <div className="overflow-x-auto border-y border-black/20">
        <table className="w-full min-w-[68rem] border-collapse text-left">
          <caption className="sr-only">
            Danh sách sản phẩm với lựa chọn hàng loạt, trạng thái nội dung, collection, giá tham
            chiếu và tình trạng vận hành
          </caption>
          <thead>
            <tr className="border-b border-black/20 text-[0.65rem] uppercase tracking-[0.14em] text-black/60">
              <th className="w-12 py-2 pr-3 font-semibold" scope="col">
                <input
                  ref={selectAllRef}
                  aria-label="Chọn tất cả sản phẩm trên trang này"
                  checked={allSelected}
                  className="h-5 w-5 accent-black focus-visible:outline-2 focus-visible:outline-offset-2"
                  onChange={(event) => toggleCurrentPage(event.target.checked)}
                  type="checkbox"
                />
              </th>
              <th className="py-3 pr-4 font-semibold" scope="col">
                <span className="sr-only">Ảnh</span>
              </th>
              <th className="py-3 pr-4 font-semibold" scope="col">Sản phẩm</th>
              <th className="py-3 pr-4 font-semibold" scope="col">Trạng thái</th>
              <th className="py-3 pr-4 font-semibold" scope="col">Collection</th>
              <th className="py-3 pr-4 font-semibold" scope="col">Giá</th>
              <th className="py-3 pr-4 font-semibold" scope="col">Biến thể</th>
              <th className="py-3 font-semibold" scope="col">
                <span className="sr-only">Hành động</span>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-black/12">
            {products.map((product) => (
              <tr className="align-middle transition-colors hover:bg-black/[0.03]" key={product.id}>
                <td className="py-2 pr-3">
                  <input
                    aria-label={`Chọn ${product.name}`}
                    checked={selectedIds.has(product.id)}
                    className="h-5 w-5 accent-black focus-visible:outline-2 focus-visible:outline-offset-2"
                    name="productId"
                    onChange={(event) => toggleProduct(product.id, event.target.checked)}
                    type="checkbox"
                    value={product.id}
                  />
                </td>
                <td className="py-3 pr-4">
                  {product.primaryImageUrl ? (
                    <div className="relative aspect-[3/4] w-12 overflow-hidden border border-black/15 bg-[var(--stone)]">
                      <Image
                        alt=""
                        className="object-cover"
                        fill
                        sizes="48px"
                        src={product.primaryImageUrl}
                        unoptimized
                      />
                    </div>
                  ) : (
                    <div className="flex aspect-[3/4] w-12 items-center justify-center border border-black/15 bg-black/5 text-[0.55rem] uppercase tracking-wider text-black/70">
                      Không ảnh
                    </div>
                  )}
                </td>
                <td className="py-3 pr-4">
                  <Link
                    className="font-display text-lg leading-tight tracking-[-0.02em] underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-4"
                    href={`/admin/products/${product.id}`}
                  >
                    {product.name}
                  </Link>
                  <p className="mt-1 text-xs text-black/55">/{product.slug}</p>
                  {!product.isActive ? (
                    <p className="mt-1 text-[0.65rem] font-semibold uppercase tracking-[0.12em] text-black/55">
                      Không hoạt động
                    </p>
                  ) : null}
                  {product.missingImage ? (
                    <p className="mt-1 text-[0.65rem] font-semibold uppercase tracking-[0.12em] text-amber-900">
                      Thiếu ảnh
                    </p>
                  ) : null}
                </td>
                <td className="py-3 pr-4">
                  <span className={`inline-block rounded-full px-2 py-0.5 text-[0.65rem] font-semibold uppercase tracking-wider ${statusStyles[product.status]}`}>
                    {statusLabels[product.status]}
                  </span>
                </td>
                <td className="py-3 pr-4">
                  {product.collections.length === 0 ? (
                    <span className="text-xs text-black/60">Chưa phân loại</span>
                  ) : (
                    <span className="flex flex-wrap gap-1">
                      {product.collections.map((collection) => (
                        <Link
                          className="inline-flex min-h-7 items-center border border-black/20 px-2 py-0.5 text-xs transition-colors hover:border-black focus-visible:outline-2 focus-visible:outline-offset-2"
                          href={collection.href}
                          key={collection.slug}
                        >
                          {collection.label}
                        </Link>
                      ))}
                    </span>
                  )}
                </td>
                <td className="py-3 pr-4 text-sm font-semibold">{product.price ?? "—"}</td>
                <td className="py-3 pr-4 text-sm text-black/60">
                  <span>
                    Biến thể: {product.activeVariantCount} / {product.variantCount} active
                  </span>
                  {product.stockedInactiveCount > 0 ? (
                    <span className="mt-1 block text-[0.7rem] font-semibold text-amber-900">
                      {product.stockedInactiveCount} variant có hàng nhưng đang tắt
                    </span>
                  ) : null}
                </td>
                <td className="py-3">
                  <Link
                    className="inline-flex min-h-11 items-center border border-black px-4 py-2 text-xs font-semibold uppercase tracking-[0.14em] transition-colors hover:bg-black hover:text-white focus-visible:outline-2 focus-visible:outline-offset-4"
                    href={`/admin/products/${product.id}`}
                  >
                    Biên tập
                    <span className="sr-only"> {product.name}</span>
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </form>
  );
}
