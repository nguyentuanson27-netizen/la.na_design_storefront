import type { PancakeCatalogField } from "../integrations/pancake/catalog-contract.ts";

export function normalizedFieldDimension(name: string): "color" | "size" | null {
  const normalized = name.trim().toLowerCase();
  if (normalized === "size" || normalized === "kích thước" || normalized === "kich thuoc") {
    return "size";
  }
  if (
    normalized === "color" ||
    normalized === "màu" ||
    normalized === "màu sắc" ||
    normalized === "mau sac" ||
    normalized === "màu quần" ||
    normalized === "mau quan" ||
    normalized === "phân loại" ||
    normalized === "phan loai" ||
    normalized === "mẫu mã" ||
    normalized === "mau ma"
  ) {
    return "color";
  }
  return null;
}

/**
 * True when a variation's fields could describe a size: a size-named field (even with a blank or
 * conflicting value) or any field whose name this mapping does not recognise (for example "Cỡ").
 * Field names are presentation data, so an unrecognised one is not evidence that no size exists.
 */
export function hasSizeEvidence(fields: readonly PancakeCatalogField[]): boolean {
  return fields.some((field) => {
    const dimension = normalizedFieldDimension(field.name);
    if (dimension === "size") return true;
    return dimension === null && (field.name.trim().length > 0 || field.value.trim().length > 0);
  });
}

/**
 * Reads the Pancake fields persisted on a variant mirror row (`pancakeFields`, Json?).
 * Returns null when the stored value is not a well-formed field list, so a caller never treats
 * a malformed row as evidence of anything.
 */
export function parseStoredCatalogFields(raw: unknown): PancakeCatalogField[] | null {
  if (!Array.isArray(raw)) return null;
  const fields: PancakeCatalogField[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) return null;
    const { id, keyValue, name, value } = entry as Record<string, unknown>;
    if (typeof name !== "string" || typeof value !== "string") return null;
    fields.push({
      id: typeof id === "string" ? id : "",
      keyValue: typeof keyValue === "string" ? keyValue : "",
      name,
      value,
    });
  }
  return fields;
}

/**
 * True when a stored variant's size "F" came from the freesize default rather than from Pancake:
 * the size is "F" and the stored fields carry no size evidence at all. Unreadable fields are never
 * inferred, so an explicit size is never taken away because its source row looks odd.
 */
export function isInferredFreesize(size: string | null, rawFields: unknown): boolean {
  if (size !== "F") return false;
  const fields = parseStoredCatalogFields(rawFields);
  return fields !== null && !hasSizeEvidence(fields);
}
