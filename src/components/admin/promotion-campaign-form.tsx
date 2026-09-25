"use client";

import { useId, useState, useTransition } from "react";
import Link from "next/link";
import { searchPromotionTargetsAction } from "@/app/admin/promotions/actions";
import { MAX_TARGETS_PER_CAMPAIGN } from "@/commerce/promotion-activation";
import type { PromotionCampaignKind } from "@/commerce/promotion-pricing";

export type FormTargetItem = Readonly<{
  id: string;
  scope: "PRODUCT" | "VARIANT";
  productId: string | null;
  variantId: string | null;
  label: string;
}>;

export type PromotionCampaignFormProps = Readonly<{
  mode: "create" | "edit";
  initialData?: {
    id: string;
    name: string;
    kind: PromotionCampaignKind;
    discountType: "PERCENTAGE" | "FIXED_PRICE";
    percentageValue: number | null;
    fixedPriceVnd: bigint | null;
    startsAt: Date | null;
    endsAt: Date | null;
    status?: string;
    targets: readonly FormTargetItem[];
  };
  action: (formData: FormData) => void | Promise<void>;
}>;

const inputClassName =
  "w-full border-b border-black/30 bg-transparent px-0 py-2 text-base outline-none transition-colors placeholder:text-neutral-500 focus-visible:border-black focus-visible:outline-2 focus-visible:outline-offset-4";

const selectClassName =
  "w-full border-b border-black/30 bg-transparent px-0 py-2 text-base outline-none transition-colors focus-visible:border-black focus-visible:outline-2 focus-visible:outline-offset-4";

const buttonClassName =
  "inline-flex min-h-11 items-center justify-center border border-black/30 px-4 text-xs font-semibold uppercase tracking-[0.14em] transition-colors hover:border-black focus-visible:outline-2 focus-visible:outline-offset-4 disabled:cursor-not-allowed disabled:opacity-35";

const primaryButtonClassName =
  "inline-flex min-h-11 items-center justify-center border border-black bg-black px-6 text-xs font-semibold uppercase tracking-[0.14em] text-white transition-colors hover:bg-neutral-800 focus-visible:outline-2 focus-visible:outline-offset-4 disabled:cursor-not-allowed disabled:opacity-35";

function formatVietnamDateTimeLocal(date: Date | null | undefined): string {
  if (!date) return "";
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return "";
  const vnTime = new Date(d.getTime() + 7 * 60 * 60 * 1000);
  const year = vnTime.getUTCFullYear();
  const month = String(vnTime.getUTCMonth() + 1).padStart(2, "0");
  const day = String(vnTime.getUTCDate()).padStart(2, "0");
  const hours = String(vnTime.getUTCHours()).padStart(2, "0");
  const minutes = String(vnTime.getUTCMinutes()).padStart(2, "0");
  return `${year}-${month}-${day}T${hours}:${minutes}`;
}

export function PromotionCampaignForm({
  mode,
  initialData,
  action,
}: PromotionCampaignFormProps) {
  const formId = useId();
  const [kind, setKind] = useState<PromotionCampaignKind>(
    initialData?.kind ?? "PROMOTION",
  );
  const [discountType, setDiscountType] = useState<"PERCENTAGE" | "FIXED_PRICE">(
    initialData?.discountType ?? "PERCENTAGE",
  );

  const [targets, setTargets] = useState<FormTargetItem[]>(() =>
    initialData ? [...initialData.targets] : [],
  );

  // Search state
  const [searchScope, setSearchScope] = useState<"PRODUCT" | "VARIANT">("PRODUCT");
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<FormTargetItem[]>([]);
  const [targetFeedback, setTargetFeedback] = useState<string | null>(null);
  const [isSearching, startSearching] = useTransition();

  function handleSearch() {
    setTargetFeedback(null);
    startSearching(async () => {
      const results = await searchPromotionTargetsAction(searchQuery, searchScope);
      setSearchResults(results);
      if (results.length === 0) {
        setTargetFeedback("Không tìm thấy kết quả phù hợp.");
      }
    });
  }

  function handleAddTarget(item: FormTargetItem) {
    setTargetFeedback(null);
    if (targets.length >= MAX_TARGETS_PER_CAMPAIGN) {
      setTargetFeedback(`Đã đạt giới hạn tối đa ${MAX_TARGETS_PER_CAMPAIGN} mục áp dụng.`);
      return;
    }

    const exists = targets.some((t) =>
      item.scope === "PRODUCT"
        ? t.scope === "PRODUCT" && t.productId === item.productId
        : t.scope === "VARIANT" && t.variantId === item.variantId,
    );

    if (exists) {
      setTargetFeedback("Mục này đã có trong danh sách áp dụng.");
      return;
    }

    setTargets((prev) => [...prev, item]);
  }

  function handleRemoveTarget(indexToRemove: number) {
    setTargetFeedback(null);
    setTargets((prev) => prev.filter((_, i) => i !== indexToRemove));
  }

  return (
    <form action={action} className="space-y-8">
      {mode === "edit" && initialData ? (
        <input name="campaignId" type="hidden" value={initialData.id} />
      ) : null}

      {/* Hidden inputs to send targets via standard FormData */}
      {targets.map((t) =>
        t.scope === "PRODUCT" && t.productId ? (
          <input key={`target-p-${t.productId}`} name="targetProductId" type="hidden" value={t.productId} />
        ) : t.scope === "VARIANT" && t.variantId ? (
          <input key={`target-v-${t.variantId}`} name="targetVariantId" type="hidden" value={t.variantId} />
        ) : null,
      )}

      <div className="grid gap-6 md:grid-cols-2">
        <div>
          <label className="text-xs font-semibold uppercase tracking-[0.14em]" htmlFor={`${formId}-name`}>
            Tên chiến dịch <span aria-hidden="true">*</span>
          </label>
          <input
            className={inputClassName}
            defaultValue={initialData?.name ?? ""}
            id={`${formId}-name`}
            maxLength={120}
            name="name"
            placeholder="Ví dụ: Giảm giá mùa tựu trường"
            required
            type="text"
          />
          <p className="mt-1 text-xs text-neutral-700">Tối đa 120 ký tự.</p>
        </div>

        <div>
          <label className="text-xs font-semibold uppercase tracking-[0.14em]" htmlFor={`${formId}-kind`}>
            Loại chiến dịch <span aria-hidden="true">*</span>
          </label>
          <select
            className={selectClassName}
            id={`${formId}-kind`}
            name="kind"
            onChange={(e) => setKind(e.target.value as PromotionCampaignKind)}
            value={kind}
          >
            <option value="PROMOTION">Khuyến mãi thông thường</option>
            <option value="FLASH_SALE">Flash Sale (yêu cầu khoảng thời gian)</option>
            <option value="CLEARANCE">Xả hàng lẻ size</option>
          </select>
        </div>
      </div>

      <fieldset className="border-t border-black/20 pt-6">
        <legend className="text-xs font-semibold uppercase tracking-[0.14em]">Cấu hình giảm giá</legend>

        <div className="mt-4 flex flex-wrap gap-6">
          <label className="inline-flex items-center gap-2 text-sm">
            <input
              checked={discountType === "PERCENTAGE"}
              name="discountType"
              onChange={() => setDiscountType("PERCENTAGE")}
              type="radio"
              value="PERCENTAGE"
            />
            <span>Theo phần trăm (%)</span>
          </label>
          <label className="inline-flex items-center gap-2 text-sm">
            <input
              checked={discountType === "FIXED_PRICE"}
              name="discountType"
              onChange={() => setDiscountType("FIXED_PRICE")}
              type="radio"
              value="FIXED_PRICE"
            />
            <span>Giá cố định (VND)</span>
          </label>
        </div>

        <div className="mt-4 max-w-sm">
          {discountType === "PERCENTAGE" ? (
            <div>
              <label className="text-xs font-semibold uppercase tracking-[0.14em]" htmlFor={`${formId}-percentage`}>
                Mức giảm (%)
              </label>
              <input
                className={inputClassName}
                defaultValue={initialData?.percentageValue ?? ""}
                id={`${formId}-percentage`}
                max={99}
                min={1}
                name="percentageValue"
                placeholder="1 - 99"
                step={1}
                type="number"
              />
              <p className="mt-1 text-xs text-neutral-700">Số nguyên từ 1% đến 99%.</p>
            </div>
          ) : (
            <div>
              <label className="text-xs font-semibold uppercase tracking-[0.14em]" htmlFor={`${formId}-fixed-price`}>
                Giá bán cuối cùng (VNĐ)
              </label>
              <input
                className={inputClassName}
                defaultValue={initialData?.fixedPriceVnd ? String(initialData.fixedPriceVnd) : ""}
                id={`${formId}-fixed-price`}
                inputMode="numeric"
                name="fixedPriceVnd"
                placeholder="Ví dụ: 199000"
                type="text"
              />
              <p className="mt-1 text-xs text-neutral-700">Đơn vị VNĐ, số nguyên dương lớn hơn 0.</p>
            </div>
          )}
        </div>
      </fieldset>

      <fieldset className="border-t border-black/20 pt-6">
        <legend className="text-xs font-semibold uppercase tracking-[0.14em]">
          Thời gian áp dụng (Asia/Ho_Chi_Minh)
        </legend>
        <p className="mt-1 text-xs text-neutral-700">
          {kind === "FLASH_SALE"
            ? "Flash Sale bắt buộc phải có cả thời gian bắt đầu và kết thúc."
            : "Để trống nếu chiến dịch không giới hạn thời gian."}
        </p>

        <div className="mt-4 grid gap-6 md:grid-cols-2">
          <div>
            <label className="text-xs font-semibold uppercase tracking-[0.14em]" htmlFor={`${formId}-starts-at`}>
              Bắt đầu
            </label>
            <input
              className={inputClassName}
              defaultValue={formatVietnamDateTimeLocal(initialData?.startsAt)}
              id={`${formId}-starts-at`}
              name="startsAt"
              type="datetime-local"
            />
          </div>

          <div>
            <label className="text-xs font-semibold uppercase tracking-[0.14em]" htmlFor={`${formId}-ends-at`}>
              Kết thúc
            </label>
            <input
              className={inputClassName}
              defaultValue={formatVietnamDateTimeLocal(initialData?.endsAt)}
              id={`${formId}-ends-at`}
              name="endsAt"
              type="datetime-local"
            />
          </div>
        </div>
      </fieldset>

      {/* Target Picker Section */}
      <section aria-labelledby={`${formId}-target-heading`} className="border-t border-black/20 pt-6">
        <div className="flex flex-col gap-2 md:flex-row md:items-baseline md:justify-between">
          <h2 className="text-xs font-semibold uppercase tracking-[0.14em]" id={`${formId}-target-heading`}>
            Danh sách áp dụng ({targets.length}/{MAX_TARGETS_PER_CAMPAIGN})
          </h2>
          <p className="text-xs text-neutral-700">
            Sản phẩm bao phủ tất cả phiên bản hiện tại và tương lai. Biến thể chỉ áp dụng đúng phiên bản được chọn.
          </p>
        </div>

        {/* Search for targets */}
        <div className="mt-4 border border-black/20 bg-black/[0.02] p-4">
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-neutral-900">
            Tìm và thêm mục áp dụng
          </p>

          <div className="mt-3 flex flex-wrap items-center gap-4">
            <label className="inline-flex items-center gap-2 text-xs font-medium">
              <input
                checked={searchScope === "PRODUCT"}
                name="targetScopeSelector"
                onChange={() => setSearchScope("PRODUCT")}
                type="radio"
                value="PRODUCT"
              />
              <span>Sản phẩm</span>
            </label>
            <label className="inline-flex items-center gap-2 text-xs font-medium">
              <input
                checked={searchScope === "VARIANT"}
                name="targetScopeSelector"
                onChange={() => setSearchScope("VARIANT")}
                type="radio"
                value="VARIANT"
              />
              <span>Phiên bản (Biến thể)</span>
            </label>
          </div>

          <div className="mt-3 flex flex-wrap gap-2">
            <div className="min-w-64 flex-1">
              <label className="sr-only" htmlFor={`${formId}-target-search`}>
                Từ khóa tìm kiếm mục áp dụng
              </label>
              <input
                className="w-full border border-black/30 bg-white px-3 py-2 text-sm outline-none focus-visible:border-black focus-visible:outline-2 focus-visible:outline-offset-2 placeholder:text-neutral-500"
                id={`${formId}-target-search`}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    handleSearch();
                  }
                }}
                placeholder={
                  searchScope === "PRODUCT"
                    ? "Nhập tên sản phẩm cần tìm..."
                    : "Nhập SKU, màu, size hoặc tên sản phẩm..."
                }
                type="search"
                value={searchQuery}
              />
            </div>
            <button
              className={buttonClassName}
              disabled={isSearching}
              onClick={handleSearch}
              type="button"
            >
              {isSearching ? "Đang tìm..." : "Tìm mục"}
            </button>
          </div>

          {targetFeedback ? (
            <p className="mt-2 text-xs text-amber-900 font-medium" role="status">
              {targetFeedback}
            </p>
          ) : null}

          {searchResults.length > 0 ? (
            <div className="mt-4 max-h-48 overflow-y-auto border border-black/20 bg-white p-2">
              <ul className="divide-y divide-black/10 text-xs">
                {searchResults.map((item) => {
                  const alreadyAdded = targets.some((t) =>
                    item.scope === "PRODUCT"
                      ? t.scope === "PRODUCT" && t.productId === item.productId
                      : t.scope === "VARIANT" && t.variantId === item.variantId,
                  );

                  return (
                    <li className="flex items-center justify-between py-2" key={item.id}>
                      <span className="pr-4">
                        <span className="mr-2 inline-block rounded bg-black/10 px-1.5 py-0.5 text-[0.65rem] font-semibold uppercase tracking-wider text-neutral-900">
                          {item.scope === "PRODUCT" ? "Sản phẩm" : "Biến thể"}
                        </span>
                        {item.label}
                      </span>
                      <button
                        className="min-h-8 border border-black/30 px-2 py-1 text-[0.7rem] font-semibold uppercase tracking-[0.1em] hover:border-black disabled:opacity-40"
                        disabled={alreadyAdded}
                        onClick={() => handleAddTarget(item)}
                        type="button"
                      >
                        {alreadyAdded ? "Đã thêm" : "+ Thêm"}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : null}
        </div>

        {/* Selected targets table */}
        <div className="mt-4">
          {targets.length === 0 ? (
            <p className="py-4 text-xs italic text-neutral-700">
              Chưa có mục nào được chọn. Hãy tìm và thêm sản phẩm hoặc phiên bản ở trên.
            </p>
          ) : (
            <div className="max-h-64 overflow-y-auto border border-black/20">
              <table className="w-full border-collapse text-left text-xs">
                <caption className="sr-only">Danh sách mục đã chọn cho chiến dịch</caption>
                <thead>
                  <tr className="border-b border-black/20 bg-black/[0.02] text-neutral-800">
                    <th className="py-2 pl-3 pr-2 font-semibold uppercase tracking-wider" scope="col">
                      Phạm vi
                    </th>
                    <th className="py-2 px-2 font-semibold uppercase tracking-wider" scope="col">
                      Tên / Chi tiết
                    </th>
                    <th className="py-2 pr-3 text-right font-semibold uppercase tracking-wider" scope="col">
                      Thao tác
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-black/10">
                  {targets.map((target, idx) => (
                    <tr key={target.id || `target-${idx}`}>
                      <td className="py-2 pl-3 pr-2">
                        <span className="inline-block rounded bg-black/10 px-1.5 py-0.5 text-[0.65rem] font-semibold uppercase tracking-wider">
                          {target.scope === "PRODUCT" ? "Sản phẩm" : "Biến thể"}
                        </span>
                      </td>
                      <td className="py-2 px-2 font-medium">{target.label}</td>
                      <td className="py-2 pr-3 text-right">
                        <button
                          aria-label={`Xóa ${target.label}`}
                          className="text-xs font-semibold uppercase tracking-wider text-red-700 underline-offset-4 hover:underline"
                          onClick={() => handleRemoveTarget(idx)}
                          type="button"
                        >
                          Xóa
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>

      {/* Form Submission Actions */}
      <div className="flex flex-wrap items-center gap-4 border-t border-black/20 pt-6">
        <button className={primaryButtonClassName} type="submit">
          {mode === "create" ? "Tạo chiến dịch (Nháp)" : "Lưu thay đổi"}
        </button>
        <Link className={buttonClassName} href="/admin/promotions">
          Hủy
        </Link>
      </div>
    </form>
  );
}
