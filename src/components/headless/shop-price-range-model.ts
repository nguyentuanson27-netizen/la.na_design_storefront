/**
 * What the `/shop` price fields say before the form is sent.
 *
 * The loader answers a malformed price with a 404 (`parseStorefrontDiscoverySearchParams` throws on
 * anything that is not a plain non-negative integer within the limit, or a minimum above the
 * maximum). A shopper typing `1e5` or swapping the two boxes should be told in the field, not land on
 * a not-found page, so the field applies the loader's own rules and states which one failed.
 */

const PLAIN_INTEGER = /^(0|[1-9][0-9]*)$/;

export type ShopPriceRangeIssue = Readonly<{
  field: "min" | "max";
  message: string;
}>;

export function validateShopPriceRange({
  min,
  max,
  limitVnd,
}: Readonly<{ min: string; max: string; limitVnd: number }>): ShopPriceRangeIssue | null {
  const minText = min.trim();
  const maxText = max.trim();

  for (const [field, text, label] of [
    ["min", minText, "tối thiểu"],
    ["max", maxText, "tối đa"],
  ] as const) {
    if (text === "") continue;
    if (!PLAIN_INTEGER.test(text)) {
      return { field, message: `Giá ${label} chỉ gồm chữ số, ví dụ 500000.` };
    }
    const value = Number(text);
    if (!Number.isSafeInteger(value) || value > limitVnd) {
      return {
        field,
        message: `Giá ${label} không được vượt quá ${limitVnd.toLocaleString("vi-VN")} ₫.`,
      };
    }
  }

  if (minText !== "" && maxText !== "" && Number(minText) > Number(maxText)) {
    return { field: "max", message: "Giá tối đa phải lớn hơn hoặc bằng giá tối thiểu." };
  }

  return null;
}
