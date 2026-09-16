import {
  AUTHORIZED_CODES,
  AUTHORIZED_SHOP_ID,
  CapabilityProbeGuardError,
  asNonEmptyString,
  assertShopAuthorized,
  isRecord,
  type JsonRecord,
  type ProbeApiClient,
  type ResolvedProbeTargets,
  type VariationStockInfo,
} from "./capability-probe-core.ts";

const VARIATION_DISCOVERY_PAGE_SIZE = 50;
const MAX_VARIATION_DISCOVERY_PAGES = 10;

function readVariationWarehouseIds(variation: JsonRecord): string[] {
  if (!Array.isArray(variation.variations_warehouses)) return [];
  return variation.variations_warehouses
    .filter((value): value is JsonRecord => isRecord(value))
    .map((value) => asNonEmptyString(value.warehouse_id))
    .filter((value): value is string => value !== null);
}

function readWarehouseStock(variation: JsonRecord, warehouseId: string): number {
  if (Array.isArray(variation.variations_warehouses)) {
    for (const rawWarehouse of variation.variations_warehouses) {
      if (!isRecord(rawWarehouse) || rawWarehouse.warehouse_id !== warehouseId) continue;
      if (typeof rawWarehouse.remain_quantity === "number") return rawWarehouse.remain_quantity;
    }
  }
  return typeof variation.remain_quantity === "number" ? variation.remain_quantity : 0;
}

async function listAllVariations(client: ProbeApiClient, shopId: number): Promise<JsonRecord[]> {
  const result: JsonRecord[] = [];
  let page = 1;
  let paginationMode: "unknown" | "declared" | "implicit" = "unknown";
  let declaredTotalPages: number | null = null;

  while (true) {
    const raw = await client.getJson(`/shops/${shopId}/products/variations`, {
      page_number: page,
      page_size: VARIATION_DISCOVERY_PAGE_SIZE,
    });
    if (!isRecord(raw) || !Array.isArray(raw.data)) {
      throw new CapabilityProbeGuardError("Pancake variation discovery returned an invalid payload");
    }
    for (const item of raw.data) if (isRecord(item)) result.push(item);

    if (raw.total_pages === undefined) {
      if (paginationMode === "declared") {
        throw new CapabilityProbeGuardError(
          "Pancake variation discovery pagination metadata disappeared across pages",
        );
      }
      paginationMode = "implicit";
      if (raw.data.length < VARIATION_DISCOVERY_PAGE_SIZE) break;
      if (page >= MAX_VARIATION_DISCOVERY_PAGES) {
        throw new CapabilityProbeGuardError(
          `Pancake variation discovery reached the ${MAX_VARIATION_DISCOVERY_PAGES}-page cap without complete pagination metadata`,
        );
      }
    } else {
      const totalPages = raw.total_pages;
      if (
        typeof totalPages !== "number" ||
        !Number.isSafeInteger(totalPages) ||
        totalPages < 1 ||
        totalPages > MAX_VARIATION_DISCOVERY_PAGES ||
        totalPages < page
      ) {
        throw new CapabilityProbeGuardError(
          `Pancake variation discovery returned invalid pagination metadata on page ${page}`,
        );
      }
      if (paginationMode === "implicit") {
        throw new CapabilityProbeGuardError(
          "Pancake variation discovery pagination metadata appeared after being absent",
        );
      }
      if (declaredTotalPages !== null && declaredTotalPages !== totalPages) {
        throw new CapabilityProbeGuardError(
          "Pancake variation discovery returned contradictory pagination metadata across pages",
        );
      }
      paginationMode = "declared";
      declaredTotalPages = totalPages;
      if (page >= totalPages) break;
    }

    page += 1;
  }
  return result;
}

function requireUniqueByDisplayId(
  variations: readonly JsonRecord[],
  displayId: string,
  label: string,
): JsonRecord {
  const matches = variations.filter((variation) => variation.display_id === displayId);
  if (matches.length !== 1) {
    throw new CapabilityProbeGuardError(
      `${label} ${displayId} resolved ${matches.length} variations; expected exactly 1`,
    );
  }
  return matches[0]!;
}

function requireVariationId(variation: JsonRecord, label: string): string {
  const id = asNonEmptyString(variation.id);
  if (!id) throw new CapabilityProbeGuardError(`${label} is missing a variation id`);
  return id;
}

function requireProductId(variation: JsonRecord, label: string): string {
  const direct = asNonEmptyString(variation.product_id);
  if (direct) return direct;
  const product = isRecord(variation.product) ? variation.product : null;
  const nested = asNonEmptyString(product?.id);
  if (!nested) throw new CapabilityProbeGuardError(`${label} is missing a product id`);
  return nested;
}

export async function discoverAndValidateProbeTargets(
  client: ProbeApiClient,
  shopId: number,
): Promise<ResolvedProbeTargets> {
  assertShopAuthorized(shopId);
  const variations = await listAllVariations(client, shopId);

  const ordinary = requireUniqueByDisplayId(
    variations,
    `${AUTHORIZED_CODES.ORDINARY}-S`,
    "Ordinary target",
  );
  if (ordinary.is_composite === true) {
    throw new CapabilityProbeGuardError("V8014-S unexpectedly resolves to a composite variation");
  }
  const ordinaryProduct = isRecord(ordinary.product) ? ordinary.product : null;
  if (ordinaryProduct?.display_id !== AUTHORIZED_CODES.ORDINARY) {
    throw new CapabilityProbeGuardError(
      `V8014-S does not belong to the authorized ${AUTHORIZED_CODES.ORDINARY} product`,
    );
  }

  const childAo = requireUniqueByDisplayId(
    variations,
    AUTHORIZED_CODES.COMPOSITE_CHILD_AO,
    "Composite child",
  );
  const childVay = requireUniqueByDisplayId(
    variations,
    AUTHORIZED_CODES.COMPOSITE_CHILD_VAY,
    "Composite child",
  );
  const parent = requireUniqueByDisplayId(
    variations,
    AUTHORIZED_CODES.COMPOSITE_PARENT,
    "Composite parent",
  );
  if (parent.is_composite !== true) {
    throw new CapabilityProbeGuardError(`${AUTHORIZED_CODES.COMPOSITE_PARENT} is not composite`);
  }

  const expectedAoId = requireVariationId(childAo, AUTHORIZED_CODES.COMPOSITE_CHILD_AO);
  const expectedVayId = requireVariationId(childVay, AUTHORIZED_CODES.COMPOSITE_CHILD_VAY);
  const compositeEntries = Array.isArray(parent.composite_products) ? parent.composite_products : [];
  if (compositeEntries.length !== 2) {
    throw new CapabilityProbeGuardError(
      `${AUTHORIZED_CODES.COMPOSITE_PARENT} has ${compositeEntries.length} components; expected 2`,
    );
  }

  const seen = new Set<string>();
  for (const rawEntry of compositeEntries) {
    if (!isRecord(rawEntry)) {
      throw new CapabilityProbeGuardError("Composite relationship contains an invalid entry");
    }
    const component = isRecord(rawEntry.component) ? rawEntry.component : null;
    const componentId = asNonEmptyString(rawEntry.component_id) ?? asNonEmptyString(component?.id);
    if (!componentId) {
      throw new CapabilityProbeGuardError(
        "Composite relationship is missing the exact component variation id",
      );
    }
    if (componentId !== expectedAoId && componentId !== expectedVayId) {
      throw new CapabilityProbeGuardError(
        `${AUTHORIZED_CODES.COMPOSITE_PARENT} references unauthorized component variation ${componentId}`,
      );
    }
    if (rawEntry.quantity !== 1) {
      throw new CapabilityProbeGuardError(
        `${AUTHORIZED_CODES.COMPOSITE_PARENT} component ${componentId} multiplier is not the authorized 1:1 fixture`,
      );
    }
    if (seen.has(componentId)) {
      throw new CapabilityProbeGuardError(`Composite relationship duplicates component ${componentId}`);
    }
    seen.add(componentId);
  }
  if (!seen.has(expectedAoId) || !seen.has(expectedVayId)) {
    throw new CapabilityProbeGuardError(
      "Composite relationship does not contain both authorized child variations",
    );
  }

  const ordinaryWarehouses = readVariationWarehouseIds(ordinary);
  const parentWarehouses = readVariationWarehouseIds(parent);
  const aoWarehouses = readVariationWarehouseIds(childAo);
  const vayWarehouses = readVariationWarehouseIds(childVay);
  const commonWarehouses = ordinaryWarehouses.filter(
    (warehouseId) =>
      parentWarehouses.includes(warehouseId) &&
      aoWarehouses.includes(warehouseId) &&
      vayWarehouses.includes(warehouseId),
  );
  if (commonWarehouses.length !== 1) {
    throw new CapabilityProbeGuardError(
      `Expected exactly one common warehouse across the four authorized variations; found ${commonWarehouses.length}`,
    );
  }
  const warehouseId = commonWarehouses[0]!;
  const ordinaryId = requireVariationId(ordinary, "ordinary target");
  const parentId = requireVariationId(parent, "composite parent");
  const aoId = requireVariationId(childAo, "AO child");
  const vayId = requireVariationId(childVay, "VAY child");

  return {
    shopId,
    ordinary: {
      variationId: ordinaryId,
      displayId: `${AUTHORIZED_CODES.ORDINARY}-S`,
      productId: requireProductId(ordinary, "ordinary target"),
      warehouseId,
      initialStock: readWarehouseStock(ordinary, warehouseId),
    },
    compositeParent: {
      variationId: parentId,
      displayId: AUTHORIZED_CODES.COMPOSITE_PARENT,
      productId: requireProductId(parent, "composite parent"),
      warehouseId,
      initialStock: readWarehouseStock(parent, warehouseId),
    },
    compositeChildAo: {
      variationId: aoId,
      displayId: AUTHORIZED_CODES.COMPOSITE_CHILD_AO,
      productId: requireProductId(childAo, "AO child"),
      warehouseId,
      initialStock: readWarehouseStock(childAo, warehouseId),
      multiplier: 1,
    },
    compositeChildVay: {
      variationId: vayId,
      displayId: AUTHORIZED_CODES.COMPOSITE_CHILD_VAY,
      productId: requireProductId(childVay, "VAY child"),
      warehouseId,
      initialStock: readWarehouseStock(childVay, warehouseId),
      multiplier: 1,
    },
    allowedVariationIds: new Set([ordinaryId, parentId, aoId, vayId]),
    allowedWarehouseIds: new Set([warehouseId]),
  };
}

export function assertMutationAllowed(
  targets: ResolvedProbeTargets,
  shopId: number,
  variationId: string,
  warehouseId?: string,
): void {
  assertShopAuthorized(shopId);
  if (targets.shopId !== shopId || !targets.allowedVariationIds.has(variationId)) {
    throw new CapabilityProbeGuardError(
      "Mutation target is outside the runtime-authorized variation allowlist",
    );
  }
  if (warehouseId !== undefined && !targets.allowedWarehouseIds.has(warehouseId)) {
    throw new CapabilityProbeGuardError(
      "Mutation target is outside the runtime-authorized warehouse allowlist",
    );
  }
}

export async function fetchVariationStock(
  client: ProbeApiClient,
  targets: ResolvedProbeTargets,
  variationId: string,
): Promise<VariationStockInfo> {
  assertMutationAllowed(targets, targets.shopId, variationId);
  const raw = await client.getJson(`/shops/${targets.shopId}/products/variations`, {
    "variation_ids[]": variationId,
  });
  if (!isRecord(raw) || !Array.isArray(raw.data)) {
    throw new CapabilityProbeGuardError("Variation stock read returned an invalid payload");
  }
  const matches = raw.data.filter(
    (value): value is JsonRecord => isRecord(value) && value.id === variationId,
  );
  if (matches.length !== 1) {
    throw new CapabilityProbeGuardError(
      `Variation stock read resolved ${matches.length} records for ${variationId}`,
    );
  }
  const variation = matches[0]!;
  const warehouseQuantities: Record<string, number> = {};
  if (Array.isArray(variation.variations_warehouses)) {
    for (const rawWarehouse of variation.variations_warehouses) {
      if (!isRecord(rawWarehouse)) continue;
      const warehouseId = asNonEmptyString(rawWarehouse.warehouse_id);
      if (!warehouseId || typeof rawWarehouse.remain_quantity !== "number") continue;
      warehouseQuantities[warehouseId] = rawWarehouse.remain_quantity;
    }
  }
  const authorizedWarehouse = targets.allowedWarehouseIds.values().next().value as string | undefined;
  if (!authorizedWarehouse || warehouseQuantities[authorizedWarehouse] === undefined) {
    throw new CapabilityProbeGuardError(
      "Authorized warehouse is missing from variation stock readback",
    );
  }
  return {
    variationId,
    displayId: asNonEmptyString(variation.display_id) ?? "",
    remainQuantity: warehouseQuantities[authorizedWarehouse]!,
    warehouseQuantities,
  };
}

export function assertAuthorizedShopConstant(): void {
  assertShopAuthorized(AUTHORIZED_SHOP_ID);
}
