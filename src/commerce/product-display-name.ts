// Pancake POS product names are often keyed as "<name> <product code>", e.g.
// "Set váy Diệu Liên Hoa SV605". The code is an internal merchant SKU, so the
// website shows only the name part and keeps the code apart for search. A code
// is one trailing token of ASCII letters followed by digits (optionally with
// "-", "_" or "." segments such as "SV605-2"), set off by whitespace or a
// separator, or wrapped in ()/[]. Vietnamese words never mix ASCII letters with
// digits, and a pure number ("Thu 2026") is left alone.
const PRODUCT_CODE = String.raw`#?([A-Za-z]+\d+[A-Za-z0-9]*(?:[-_.][A-Za-z0-9]+)*)`;
const SEPARATOR = String.raw`(?:\s+|\s*[-–—|:/]\s*)`;
const TRAILING_PRODUCT_CODE = new RegExp(
  String.raw`(?:${SEPARATOR}${PRODUCT_CODE}|\s*\(\s*${PRODUCT_CODE}\s*\)|\s*\[\s*${PRODUCT_CODE}\s*\])$`,
  "u",
);

// Some Pancake names carry no real name before the code, only the garment type: "SET VÁY SV771",
// "Set quần SV12". Stripping the code there would leave a bare "SET VÁY" shared by many products,
// so such names stay whole (the code is still split off into productCode). Words are matched lower-case, either exactly as listed (with
// diacritics) or, when typed without diacritics, by their unaccented form ("SET VAY"); a word typed
// with different diacritics ("đỏ" vs "đồ") is not a garment-type word.
const GARMENT_TYPE_WORDS = [
  "set",
  "bộ",
  "đồ",
  "váy",
  "đầm",
  "quần",
  "áo",
  "chân",
  "dài",
  "ngắn",
  "khoác",
  "sơ",
  "mi",
  "thun",
  "len",
  "yếm",
  "vest",
  "blazer",
  "croptop",
  "jumpsuit",
  "phụ",
  "kiện",
  "túi",
  "ví",
  "khăn",
  "mũ",
  "nón",
  "kẹp",
  "giày",
  "guốc",
  "nữ",
  "và",
] as const;

function stripDiacritics(word: string): string {
  return word.normalize("NFD").replace(/\p{M}/gu, "").replace(/đ/g, "d");
}

const ACCENTED_GARMENT_TYPE_WORDS = new Set<string>(GARMENT_TYPE_WORDS);
const UNACCENTED_GARMENT_TYPE_WORDS = new Set<string>(GARMENT_TYPE_WORDS.map(stripDiacritics));

function isGarmentTypeWord(word: string): boolean {
  const lower = word.normalize("NFC").toLowerCase();
  if (ACCENTED_GARMENT_TYPE_WORDS.has(lower)) return true;
  return stripDiacritics(lower) === lower && UNACCENTED_GARMENT_TYPE_WORDS.has(lower);
}

function isOnlyGarmentType(name: string): boolean {
  const words = name.split(/[\s,&+/]+/u).filter((word) => word.length > 0);
  return words.length > 0 && words.every(isGarmentTypeWord);
}

export type ProductDisplayName = {
  name: string;
  productCode: string | null;
};

export function splitTrailingProductCode(sourceName: string): ProductDisplayName {
  const trimmed = sourceName.trim();
  const match = TRAILING_PRODUCT_CODE.exec(trimmed);
  if (!match) return { name: trimmed, productCode: null };

  const name = trimmed.slice(0, match.index).trim();
  if (name.length === 0) return { name: trimmed, productCode: null };
  const productCode = match[1] ?? match[2] ?? match[3] ?? null;
  // A garment-type-only name keeps its code on display, but the code is still the product's code.
  if (isOnlyGarmentType(name)) return { name: trimmed, productCode };
  return { name, productCode };
}

export function stripTrailingProductCode(sourceName: string): string {
  return splitTrailingProductCode(sourceName).name;
}
