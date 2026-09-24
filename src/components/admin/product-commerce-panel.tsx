"use client";

import { useActionState, useEffect, useMemo, useRef, useState } from "react";

export type ProductCommerceWarningState = {
  zeroActiveProductIds: string[];
  compositeChildProductIds: string[];
};

export type ProductCommerceActionState =
  | { kind: "idle" }
  | {
      kind: "catalog-confirm" | "catalog-reconfirm";
      warningState: ProductCommerceWarningState;
      proof: string;
      expiresAtMs: number;
    }
  | {
      kind: "success";
      operation: "catalog-enable" | "catalog-disable" | "quick-activate";
      activatedVariantCount?: number;
    }
  | { kind: "error"; message: string };

export const initialProductCommerceActionState: ProductCommerceActionState = { kind: "idle" };

export type ProductCommerceVariantRow = {
  id: string;
  label: string;
  sku: string | null;
  color: string | null;
  size: string | null;
  stock: number;
  isActive: boolean;
  contexts: Array<"Thường" | "Set cha" | "Thành phần set">;
};

type ProductCommercePanelProps = {
  productName: string;
  productIsActive: boolean;
  collectionCount: number;
  variants: ProductCommerceVariantRow[];
  quickActionEligible: boolean;
  variantAction: (formData: FormData) => void | Promise<void>;
  commerceAction: (
    state: ProductCommerceActionState,
    formData: FormData,
  ) => ProductCommerceActionState | Promise<ProductCommerceActionState>;
};

const PAGE_SIZE = 100;

function buttonClassName(primary = false) {
  return `inline-flex min-h-11 max-w-full items-center justify-center whitespace-normal break-words border border-black px-4 py-2 text-center text-xs font-semibold uppercase tracking-[0.12em] transition-colors focus-visible:outline-2 focus-visible:outline-offset-4 disabled:cursor-not-allowed disabled:opacity-50 ${
    primary ? "bg-black text-white hover:bg-white hover:text-black" : "hover:bg-black hover:text-white"
  }`;
}

function warningCopy(
  warningState: ProductCommerceWarningState,
  productName: string,
): string[] {
  const messages: string[] = [];
  if (warningState.zeroActiveProductIds.length > 0) {
    messages.push(`${productName} hiện không có biến thể hoạt động.`);
  }
  if (warningState.compositeChildProductIds.length > 0) {
    messages.push(
      `${productName} hiện là thành phần của set/composite và sẽ được mở catalog riêng nếu tiếp tục.`,
    );
  }
  return messages;
}

export function ProductCommercePanel({
  productName,
  productIsActive,
  collectionCount,
  variants,
  quickActionEligible,
  variantAction,
  commerceAction,
}: ProductCommercePanelProps) {
  const [pageIndex, setPageIndex] = useState(0);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [quickConfirmationOriginState, setQuickConfirmationOriginState] =
    useState<ProductCommerceActionState | null>(null);
  const [catalogDismissed, setCatalogDismissed] = useState(false);
  const [commerceState, commerceFormAction, commercePending] = useActionState(
    commerceAction,
    initialProductCommerceActionState,
  );
  const selectAllRef = useRef<HTMLInputElement>(null);
  const feedbackRef = useRef<HTMLDivElement>(null);

  const pageCount = Math.max(1, Math.ceil(variants.length / PAGE_SIZE));
  const safePageIndex = Math.min(pageIndex, pageCount - 1);
  const pageStart = safePageIndex * PAGE_SIZE;
  const pageRows = variants.slice(pageStart, pageStart + PAGE_SIZE);
  const selectedCount = selectedIds.size;
  const allSelected = pageRows.length > 0 && selectedCount === pageRows.length;
  const partlySelected = selectedCount > 0 && selectedCount < pageRows.length;
  const activeCount = variants.filter((variant) => variant.isActive).length;
  const positiveStockCount = variants.filter((variant) => variant.stock > 0).length;
  const totalStock = variants.reduce((sum, variant) => sum + variant.stock, 0);
  const quickConfirming = quickConfirmationOriginState === commerceState;

  const feedback = useMemo(() => {
    if (commerceState.kind === "success") {
      if (commerceState.operation === "catalog-enable") return "Đã bật catalog.";
      if (commerceState.operation === "catalog-disable") return "Đã tắt catalog.";
      return `Đã bật sản phẩm và kích hoạt ${commerceState.activatedVariantCount ?? 0} biến thể có hàng.`;
    }
    if (commerceState.kind === "catalog-reconfirm") {
      return "Trạng thái cảnh báo đã thay đổi. Vui lòng xác nhận lại.";
    }
    if (commerceState.kind === "error") return commerceState.message;
    return null;
  }, [commerceState]);

  useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate = partlySelected;
    }
  }, [partlySelected]);

  // Keyed on the action state's identity, not on the derived message: repeating an operation with
  // the same outcome produces the same string, and keying on that would leave focus and the
  // announcement stuck on the previous attempt as though nothing had happened.
  useEffect(() => {
    if (feedback) {
      requestAnimationFrame(() => feedbackRef.current?.focus());
    }
  }, [commerceState, feedback]);

  function changePage(nextPage: number) {
    setPageIndex(Math.max(0, Math.min(nextPage, pageCount - 1)));
    setSelectedIds(new Set());
  }

  function toggleVariant(variantId: string, checked: boolean) {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (checked) next.add(variantId);
      else next.delete(variantId);
      return next;
    });
  }

  function selectCurrentPage(checked: boolean) {
    setSelectedIds(checked ? new Set(pageRows.map((variant) => variant.id)) : new Set());
  }

  function selectStockedOnCurrentPage() {
    setSelectedIds(new Set(pageRows.filter((variant) => variant.stock > 0).map((variant) => variant.id)));
  }

  const rangeLabel =
    variants.length === 0
      ? "0 / 0"
      : `${pageStart + 1}–${Math.min(pageStart + pageRows.length, variants.length)} / ${variants.length}`;

  const confirmationState =
    !catalogDismissed &&
    (commerceState.kind === "catalog-confirm" || commerceState.kind === "catalog-reconfirm")
      ? commerceState
      : null;
  const confirmationWarnings = confirmationState
    ? warningCopy(confirmationState.warningState, productName)
    : [];

  return (
    <section
      aria-labelledby="website-commerce-heading"
      className="mt-8 min-w-0 max-w-full border border-black/20 bg-white p-5 md:p-7"
    >
      <p className="eyebrow">Website commerce</p>
      <div className="mt-1 flex min-w-0 flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div className="min-w-0">
          <h2 id="website-commerce-heading" className="font-display text-3xl tracking-[-0.03em]">
            Website commerce
          </h2>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-black/70">
            Catalog sản phẩm và trạng thái biến thể là dữ liệu website sở hữu. Giá, tồn kho và quan hệ composite bên dưới vẫn chỉ đọc từ mirror Pancake.
          </p>
        </div>
        <dl className="grid min-w-0 grid-cols-2 gap-x-5 gap-y-2 text-xs sm:grid-cols-5 lg:text-right">
          <div>
            <dt className="text-black/55">Catalog</dt>
            <dd className="font-semibold">{productIsActive ? "Đang bật" : "Đang tắt"}</dd>
          </div>
          <div>
            <dt className="text-black/55">Variants</dt>
            <dd className="font-semibold">{activeCount} / {variants.length} active</dd>
          </div>
          <div>
            <dt className="text-black/55">Có hàng</dt>
            <dd className="font-semibold">{positiveStockCount}</dd>
          </div>
          <div>
            <dt className="text-black/55">Tổng kho</dt>
            <dd className="font-semibold">{totalStock}</dd>
          </div>
          <div>
            <dt className="text-black/55">Collection</dt>
            <dd className="font-semibold">{collectionCount}</dd>
          </div>
        </dl>
      </div>

      <div
        ref={feedbackRef}
        aria-atomic={feedback ? "true" : undefined}
        className="mt-4 min-w-0 focus-visible:outline-2 focus-visible:outline-offset-4"
        role={
          commerceState.kind === "error"
            ? "alert"
            : commerceState.kind === "success" || commerceState.kind === "catalog-reconfirm"
              ? "status"
              : undefined
        }
        tabIndex={feedback ? -1 : undefined}
      >
        {feedback ? (
          <p className="border-l-2 border-black pl-4 text-sm font-semibold">{feedback}</p>
        ) : null}
      </div>

      <form action={commerceFormAction} className="mt-5 min-w-0 max-w-full border-t border-black/15 pt-5">
        <div className="flex min-w-0 max-w-full flex-wrap gap-3">
          {productIsActive ? (
            <button
              className={buttonClassName()}
              disabled={commercePending}
              name="intent"
              type="submit"
              value="catalog-disable"
            >
              Tắt catalog
            </button>
          ) : (
            <button
              className={buttonClassName()}
              disabled={commercePending}
              name="intent"
              onClick={() => setCatalogDismissed(false)}
              type="submit"
              value="catalog-prepare"
            >
              Bật catalog
            </button>
          )}

          {quickActionEligible ? (
            <button
              className={buttonClassName(true)}
              disabled={commercePending}
              onClick={() => setQuickConfirmationOriginState(commerceState)}
              type="button"
            >
              Bật sản phẩm + kích hoạt biến thể có hàng
            </button>
          ) : null}
        </div>

        {confirmationState ? (
          <div className="mt-4 min-w-0 max-w-full border border-amber-700/40 bg-amber-50 p-4 text-sm leading-6">
            {confirmationWarnings.map((warning) => (
              <p className="font-semibold" key={warning}>{warning}</p>
            ))}
            <p className={confirmationWarnings.length > 0 ? "mt-2" : undefined}>
              Bật catalog không tự kích hoạt biến thể.
            </p>
            <input name="proof" type="hidden" value={confirmationState.proof} />
            <div className="mt-4 flex min-w-0 max-w-full flex-wrap gap-2">
              <button
                className={buttonClassName(true)}
                disabled={commercePending}
                name="intent"
                type="submit"
                value="catalog-commit"
              >
                Xác nhận bật catalog
              </button>
              <button
                className={buttonClassName()}
                disabled={commercePending}
                onClick={() => setCatalogDismissed(true)}
                type="button"
              >
                Hủy
              </button>
            </div>
          </div>
        ) : null}

        {quickConfirming ? (
          <div className="mt-4 min-w-0 max-w-full border border-black/20 bg-black/[0.02] p-4 text-sm leading-6">
            <p>
              Thao tác sẽ bật catalog sản phẩm và kích hoạt các biến thể hiện có tổng tồn kho dương.
              Theo dữ liệu đang hiển thị: <strong>{positiveStockCount} biến thể có hàng</strong>.
            </p>
            <p className="mt-1 text-black/65">
              Server sẽ đọc lại tồn kho và quan hệ composite ngay trước khi ghi.
            </p>
            <div className="mt-4 flex min-w-0 max-w-full flex-wrap gap-2">
              <button
                className={buttonClassName(true)}
                disabled={commercePending}
                name="intent"
                type="submit"
                value="quick-activate"
              >
                Xác nhận bật sản phẩm và biến thể có hàng
              </button>
              <button
                className={buttonClassName()}
                disabled={commercePending}
                onClick={() => setQuickConfirmationOriginState(null)}
                type="button"
              >
                Hủy
              </button>
            </div>
          </div>
        ) : null}
      </form>

      <div className="mt-7 min-w-0 max-w-full border-t border-black/15 pt-6">
        <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div className="min-w-0">
            <h3 className="font-display text-2xl tracking-[-0.03em]">Biến thể website</h3>
            <p className="mt-1 text-sm text-black/65" aria-live="polite">
              {rangeLabel}
            </p>
          </div>
          {variants.length > PAGE_SIZE ? (
            <div className="flex max-w-full flex-wrap gap-2">
              <button
                aria-label="Trang biến thể trước"
                className={buttonClassName()}
                disabled={safePageIndex === 0}
                onClick={() => changePage(safePageIndex - 1)}
                type="button"
              >
                ← Trước
              </button>
              <button
                aria-label="Trang biến thể tiếp theo"
                className={buttonClassName()}
                disabled={safePageIndex >= pageCount - 1}
                onClick={() => changePage(safePageIndex + 1)}
                type="button"
              >
                Sau →
              </button>
            </div>
          ) : null}
        </div>

        {variants.length > 0 ? (
          <form action={variantAction} className="mt-4 min-w-0 max-w-full">
            {pageRows
              .filter((variant) => selectedIds.has(variant.id))
              .map((variant) => (
                <input key={variant.id} name="variantId" type="hidden" value={variant.id} />
              ))}

            <div className="mb-3 flex min-w-0 max-w-full flex-wrap items-center gap-2">
              <button
                className={buttonClassName()}
                onClick={selectStockedOnCurrentPage}
                type="button"
              >
                Chọn biến thể có hàng{variants.length > PAGE_SIZE ? " trên trang này" : ""}
              </button>
              {selectedCount > 0 ? (
                <>
                  <span className="text-sm font-semibold" aria-live="polite">
                    Đã chọn {selectedCount} biến thể
                  </span>
                  <button
                    className={buttonClassName(true)}
                    name="bulkState"
                    type="submit"
                    value="true"
                  >
                    Kích hoạt đã chọn
                  </button>
                  <button
                    className={buttonClassName()}
                    name="bulkState"
                    type="submit"
                    value="false"
                  >
                    Tắt đã chọn
                  </button>
                  <button
                    className={buttonClassName()}
                    onClick={() => setSelectedIds(new Set())}
                    type="button"
                  >
                    Bỏ chọn
                  </button>
                </>
              ) : null}
            </div>

            <div
              aria-label="Bảng biến thể website, cuộn ngang khi cần"
              className="w-full min-w-0 max-w-full overflow-x-auto border-y border-black/20"
              role="region"
              style={{ contain: "inline-size" }}
              tabIndex={0}
            >
              <table className="w-full min-w-[52rem] text-left text-xs">
                <caption className="sr-only">
                  Biến thể website với lựa chọn hàng loạt, tồn kho mirror và trạng thái kích hoạt
                </caption>
                <thead>
                  <tr className="border-b border-black/20 bg-black/5 uppercase tracking-[0.1em] text-black/70">
                    <th className="w-12 px-3 py-2.5" scope="col">
                      <input
                        ref={selectAllRef}
                        aria-label="Chọn tất cả biến thể trên trang này"
                        checked={allSelected}
                        className="size-5 accent-black focus-visible:outline-2 focus-visible:outline-offset-2"
                        onChange={(event) => selectCurrentPage(event.target.checked)}
                        type="checkbox"
                      />
                    </th>
                    <th className="px-3 py-2.5" scope="col">SKU</th>
                    <th className="px-3 py-2.5" scope="col">Màu</th>
                    <th className="px-3 py-2.5" scope="col">Size</th>
                    <th className="px-3 py-2.5" scope="col">Tồn kho</th>
                    <th className="px-3 py-2.5" scope="col">Ngữ cảnh</th>
                    <th className="px-3 py-2.5" scope="col">Trạng thái</th>
                    <th className="px-3 py-2.5" scope="col"><span className="sr-only">Hành động</span></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-black/10">
                  {pageRows.map((variant) => (
                    <tr className="align-middle hover:bg-black/[0.02]" key={variant.id}>
                      <td className="px-3 py-2.5">
                        <input
                          aria-label={`Chọn biến thể ${variant.label}`}
                          checked={selectedIds.has(variant.id)}
                          className="size-5 accent-black focus-visible:outline-2 focus-visible:outline-offset-2"
                          onChange={(event) => toggleVariant(variant.id, event.target.checked)}
                          type="checkbox"
                        />
                      </td>
                      <td className="px-3 py-2.5 font-mono">{variant.sku || variant.label}</td>
                      <td className="px-3 py-2.5">{variant.color || "—"}</td>
                      <td className="px-3 py-2.5">{variant.size || "—"}</td>
                      <td className="px-3 py-2.5 font-semibold">
                        {variant.stock > 0 ? variant.stock : "Hết hàng"}
                      </td>
                      <td className="px-3 py-2.5">
                        <div className="flex flex-wrap gap-1">
                          {variant.contexts.map((context) => (
                            <span
                              className="border border-black/20 px-2 py-1 text-[0.65rem] font-semibold uppercase tracking-[0.08em]"
                              key={context}
                            >
                              {context}
                            </span>
                          ))}
                        </div>
                      </td>
                      <td className="px-3 py-2.5 font-semibold">
                        {variant.isActive ? "Hoạt động" : "Tắt"}
                      </td>
                      <td className="px-3 py-2.5 text-right">
                        <button
                          className={buttonClassName()}
                          name={variant.isActive ? "deactivateVariantId" : "activateVariantId"}
                          type="submit"
                          value={variant.id}
                        >
                          {variant.isActive ? "Tắt" : "Kích hoạt"} biến thể {variant.label}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </form>
        ) : (
          <p className="mt-4 text-sm text-black/65">Sản phẩm hiện không có biến thể còn đồng bộ.</p>
        )}
      </div>
    </section>
  );
}
