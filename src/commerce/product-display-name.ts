// Pancake POS product names are often keyed as "<name> <product code>", e.g.
// "Set váy Diệu Liên Hoa SV605". The code is an internal merchant SKU, so the
// website shows only the name part. A code is one trailing token of ASCII
// letters followed by digits (optionally with "-", "_" or "." segments such as
// "SV605-2"), set off by whitespace or a separator, or wrapped in ()/[].
// Vietnamese words never mix ASCII letters with digits, and a pure number
// ("Thu 2026") is left alone.
const PRODUCT_CODE = String.raw`#?[A-Za-z]{1,8}\d+[A-Za-z0-9]*(?:[-_.][A-Za-z0-9]+)*`;
const SEPARATOR = String.raw`(?:\s+|\s*[-–—|:/]\s*)`;
const TRAILING_PRODUCT_CODE = new RegExp(
  String.raw`(?:${SEPARATOR}${PRODUCT_CODE}|\s*\(\s*${PRODUCT_CODE}\s*\)|\s*\[\s*${PRODUCT_CODE}\s*\])$`,
  "u",
);

export function stripTrailingProductCode(name: string): string {
  const trimmed = name.trim();
  const match = TRAILING_PRODUCT_CODE.exec(trimmed);
  if (!match) return trimmed;

  const stripped = trimmed.slice(0, match.index).trim();
  return stripped.length > 0 ? stripped : trimmed;
}
