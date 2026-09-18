export const DEFAULT_ORDER_SEARCH_PAGE_SIZE = 50;
export const DEFAULT_ORDER_SEARCH_MAX_PAGES = 3;

type QueryValue = string | number | boolean;

export type OrderSearchApiClient = {
  getJson(endpoint: string, query?: Readonly<Record<string, QueryValue>>): Promise<unknown>;
};

export type MarkerSearchResult =
  | Readonly<{ kind: "FOUND"; orderId: string }>
  | Readonly<{ kind: "ABSENT" }>
  | Readonly<{ kind: "AMBIGUOUS"; reason: string }>;

export type OrderSearchOptions = Readonly<{
  pageSize?: number;
  maxPages?: number;
}>;

export function sanitizeSecrets(message: string): string {
  return message
    .replace(
      /([?&](?:api[_-]?key|access[_-]?token|token|secret[_-]?key|secret|password)=)[^&\s]+/gi,
      "$1[REDACTED]",
    )
    .replace(
      /(["']?(?:api[_-]?key|access[_-]?token|token|secret[_-]?key|secret|password)["']?\s*[:=]\s*['"]?)[^\s&"',>]+/gi,
      "$1[REDACTED]",
    )
    .replace(/(Bearer\s+)[a-zA-Z0-9_.-]{6,}/gi, "$1[REDACTED]")
    .replace(/\b[0-9a-fA-F]{32,64}\b/g, "[REDACTED_KEY]")
    .replace(/\s+/g, " ")
    .trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireShopId(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError("Pancake shop id must be a positive safe integer");
  }
  return value;
}

function requireMarker(value: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError("Marker must be a non-empty string");
  }
  return value;
}

function validatedReportedTotalPages(
  raw: Record<string, unknown>,
  page: number,
): number | null | "INVALID" {
  if (raw.total_pages === undefined || raw.total_pages === null) return null;
  if (!Number.isInteger(raw.total_pages) || (raw.total_pages as number) < 0) return "INVALID";
  if ((raw.total_pages as number) === 0) {
    return Array.isArray(raw.data) && raw.data.length === 0 && page === 1 ? 0 : "INVALID";
  }
  if ((raw.total_pages as number) < page) return "INVALID";
  return raw.total_pages as number;
}

export async function searchOrderByMarker(
  client: OrderSearchApiClient,
  shopId: number,
  marker: string,
  options: OrderSearchOptions = {},
): Promise<MarkerSearchResult> {
  const safeShopId = requireShopId(shopId);
  const safeMarker = requireMarker(marker);

  const pageSize = options.pageSize ?? DEFAULT_ORDER_SEARCH_PAGE_SIZE;
  const maxPages = options.maxPages ?? DEFAULT_ORDER_SEARCH_MAX_PAGES;

  if (!Number.isSafeInteger(pageSize) || pageSize <= 0) {
    throw new TypeError("Page size must be a positive safe integer");
  }
  if (!Number.isSafeInteger(maxPages) || maxPages <= 0) {
    throw new TypeError("Max pages must be a positive safe integer");
  }

  const matches: string[] = [];

  try {
    for (let page = 1; page <= maxPages; page += 1) {
      const raw = await client.getJson(`/shops/${safeShopId}/orders`, {
        page_number: page,
        page_size: pageSize,
      });

      if (!isRecord(raw) || !Array.isArray(raw.data)) {
        return { kind: "AMBIGUOUS", reason: "invalid order-list response" };
      }

      for (const item of raw.data) {
        if (!isRecord(item)) continue;

        const note = typeof item.note === "string" ? item.note : "";
        const address =
          isRecord(item.shipping_address) && typeof item.shipping_address.address === "string"
            ? item.shipping_address.address
            : "";
        const addressDetail =
          isRecord(item.shipping_address) &&
          typeof item.shipping_address.address_detail === "string"
            ? item.shipping_address.address_detail
            : "";

        if (
          !note.includes(safeMarker) &&
          !address.includes(safeMarker) &&
          !addressDetail.includes(safeMarker)
        ) {
          continue;
        }

        if (item.id === undefined || item.id === null) {
          return { kind: "AMBIGUOUS", reason: "matching order has no id" };
        }

        matches.push(String(item.id));
      }

      const reportedTotalPages = validatedReportedTotalPages(raw, page);
      if (reportedTotalPages === "INVALID") {
        return { kind: "AMBIGUOUS", reason: "invalid or contradictory order pagination metadata" };
      }

      if (reportedTotalPages !== null) {
        if (page >= reportedTotalPages) break;
        if (page === maxPages) {
          return {
            kind: "AMBIGUOUS",
            reason: "bounded order search did not cover all reported pages",
          };
        }
        continue;
      }

      if (raw.data.length < pageSize) break;
      if (page === maxPages) {
        return {
          kind: "AMBIGUOUS",
          reason: "bounded order search reached its limit without authoritative pagination metadata",
        };
      }
    }
  } catch (error) {
    return {
      kind: "AMBIGUOUS",
      reason: sanitizeSecrets(error instanceof Error ? error.message : String(error)),
    };
  }

  if (matches.length === 1) return { kind: "FOUND", orderId: matches[0]! };
  if (matches.length > 1) {
    return { kind: "AMBIGUOUS", reason: "multiple orders matched the unique marker" };
  }
  return { kind: "ABSENT" };
}
