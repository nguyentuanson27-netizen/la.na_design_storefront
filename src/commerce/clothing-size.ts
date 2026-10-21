const KNOWN_SIZE_RANKS: Readonly<Record<string, number>> = {
  "3xs": 5,
  "xxx-small": 5,
  "xxs": 10,
  "2xs": 10,
  "xx-small": 10,
  "xs": 20,
  "1xs": 20,
  "x-small": 20,
  "s": 30,
  "small": 30,
  "m": 40,
  "medium": 40,
  "l": 50,
  "large": 50,
  "xl": 60,
  "1xl": 60,
  "x-large": 60,
  "xxl": 70,
  "2xl": 70,
  "xx-large": 70,
  "xxxl": 80,
  "3xl": 80,
  "xxx-large": 80,
  "xxxxl": 90,
  "4xl": 90,
  "xxxx-large": 90,
  "xxxxxl": 100,
  "5xl": 100,
  "6xl": 110,
  "fs": 200,
  "os": 200,
  "onesize": 200,
  "one size": 200,
  "freesize": 200,
  "free size": 200,
  "free": 200,
};

const STANDARD_LETTER_SIZES = new Set([
  "3xs",
  "xxs",
  "2xs",
  "xs",
  "1xs",
  "s",
  "m",
  "l",
  "xl",
  "1xl",
  "xxl",
  "2xl",
  "xxxl",
  "3xl",
  "xxxxl",
  "4xl",
  "xxxxxl",
  "5xl",
  "6xl",
  "fs",
  "os",
]);

export function canonicalizeClothingSize(size: string): string {
  const trimmed = size.trim();
  const lower = trimmed.toLowerCase();
  if (STANDARD_LETTER_SIZES.has(lower)) {
    return lower.toUpperCase();
  }
  return trimmed;
}

export function compareClothingSizes(a: string, b: string): number {
  const normA = a.trim().toLowerCase();
  const normB = b.trim().toLowerCase();
  if (normA === normB) return 0;

  const rankA = KNOWN_SIZE_RANKS[normA];
  const rankB = KNOWN_SIZE_RANKS[normB];

  if (rankA !== undefined && rankB !== undefined) {
    return rankA - rankB;
  }
  if (rankA !== undefined) return -1;
  if (rankB !== undefined) return 1;

  const numA = Number(normA);
  const numB = Number(normB);
  const isNumA = Number.isFinite(numA);
  const isNumB = Number.isFinite(numB);

  if (isNumA && isNumB) {
    return numA - numB;
  }
  if (isNumA) return -1;
  if (isNumB) return 1;

  return a.localeCompare(b, "vi", { numeric: true, sensitivity: "base" });
}

export function sortClothingSizes(sizes: readonly string[]): string[] {
  const uniqueBySize = new Map<string, string>();
  for (const size of sizes) {
    const trimmed = size.trim();
    if (!trimmed) continue;
    const canonical = canonicalizeClothingSize(trimmed);
    const key = canonical.toLowerCase();
    if (!uniqueBySize.has(key)) {
      uniqueBySize.set(key, canonical);
    } else {
      const current = uniqueBySize.get(key)!;
      if (canonical === canonical.toUpperCase() && current !== current.toUpperCase()) {
        uniqueBySize.set(key, canonical);
      }
    }
  }
  return [...uniqueBySize.values()].sort(compareClothingSizes);
}
