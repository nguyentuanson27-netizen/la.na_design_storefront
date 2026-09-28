type JsonRecord = Record<string, unknown>;

type ParsedCompositeEdge = {
  edgeId: string;
  parentVariationId: string;
  componentVariationId: string;
  componentProductId: string;
  quantity: number;
};

export type PancakeCompositeVariationIdentity = Readonly<{
  variationId: string;
  productId: string;
}>;

export type PancakeCompositeEdge = Readonly<{
  parentVariationId: string;
  componentVariationId: string;
  quantity: number;
}>;

export type PancakeCompositeSnapshot = Readonly<{
  parentVariationIds: readonly string[];
  componentVariationIds: readonly string[];
  parentIdentities: readonly PancakeCompositeVariationIdentity[];
  componentIdentities: readonly PancakeCompositeVariationIdentity[];
  edges: readonly PancakeCompositeEdge[];
  /**
   * Combos Pancake reported incompletely: no components, or a component that is missing (hidden,
   * deleted, or otherwise not resolvable). The whole combo is left out of the graph — a partial
   * graph would derive set capacity from only some of its components — and its parent variation must
   * not be sold at all, not even from its own mirrored stock. Absent means none.
   */
  quarantinedParentVariationIds?: readonly string[];
}>;

const CONTRACT_ERROR = "Pancake composite contract is malformed";
const MAX_ID_LENGTH = 512;
const MAX_COMPOSITE_ENTRIES = 50_000;
const MAX_POSTGRES_INTEGER = 2_147_483_647;

function fail(): never {
  throw new TypeError(CONTRACT_ERROR);
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireRecord(value: unknown): JsonRecord {
  if (!isRecord(value)) fail();
  return value;
}

function requireIdentity(record: JsonRecord, key: string): string {
  const value = record[key];
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_ID_LENGTH ||
    value.trim() !== value
  ) {
    fail();
  }
  return value;
}

function requirePositiveInteger(value: unknown, maximum: number): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value <= 0 ||
    value > maximum
  ) {
    fail();
  }
  return value;
}

/** Real Pancake rows report `is_composite: null` for ordinary products; it means "not composite". */
function isNonComposite(value: unknown): boolean {
  return value === false || value === null;
}

function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function compareEdges(left: PancakeCompositeEdge, right: PancakeCompositeEdge): number {
  return (
    compareStrings(left.parentVariationId, right.parentVariationId) ||
    compareStrings(left.componentVariationId, right.componentVariationId)
  );
}

function compareIdentities(
  left: PancakeCompositeVariationIdentity,
  right: PancakeCompositeVariationIdentity,
): number {
  return compareStrings(left.variationId, right.variationId);
}

function identitiesFromMap(
  productByVariationId: ReadonlyMap<string, string>,
): PancakeCompositeVariationIdentity[] {
  return [...productByVariationId.entries()]
    .map(([variationId, productId]) => ({ variationId, productId }))
    .sort(compareIdentities);
}

/**
 * Parses Pancake's parent/children composite listings into one direct, one-level graph.
 *
 * Two kinds of bad data are treated differently, on purpose:
 *
 * - **Contradictions** fail the whole snapshot: duplicate ids or edges, a non-positive or fractional
 *   quantity, another shop's edge, an edge that names a different parent, a self-edge, a nested
 *   composite, a component whose product disagrees with its own row, or a variation in both roles.
 *   Syncing through those would persist a graph nobody can vouch for.
 * - **Absence** quarantines only the combo it affects: a combo with no components, or one whose
 *   component is missing from the children listing. Real catalogs contain these (a hidden or
 *   deleted component), and one such combo must not stop every other product from syncing.
 */
export function parsePancakeCompositeSnapshot({
  shopId,
  parentEntries,
  childEntries,
}: {
  shopId: number;
  parentEntries: readonly unknown[];
  childEntries: readonly unknown[];
}): PancakeCompositeSnapshot {
  const safeShopId = requirePositiveInteger(shopId, MAX_POSTGRES_INTEGER);
  if (
    parentEntries.length > MAX_COMPOSITE_ENTRIES ||
    childEntries.length > MAX_COMPOSITE_ENTRIES
  ) {
    fail();
  }

  const parentProductByVariationId = new Map<string, string>();
  const quarantinedParentIds = new Set<string>();
  const childProductByVariationId = new Map<string, string>();
  const edgeIds = new Set<string>();
  const edgePairs = new Set<string>();
  const parsedEdges: ParsedCompositeEdge[] = [];
  let edgeCount = 0;

  for (const entryValue of parentEntries) {
    const entry = requireRecord(entryValue);
    const parentVariationId = requireIdentity(entry, "id");
    const parentProductId = requireIdentity(entry, "product_id");
    if (entry.is_composite !== true || !Array.isArray(entry.composite_products)) fail();
    if (parentProductByVariationId.has(parentVariationId)) fail();
    parentProductByVariationId.set(parentVariationId, parentProductId);

    if (entry.composite_products.length === 0) {
      quarantinedParentIds.add(parentVariationId);
      continue;
    }
    edgeCount += entry.composite_products.length;
    if (edgeCount > MAX_COMPOSITE_ENTRIES) fail();

    for (const edgeValue of entry.composite_products) {
      const edge = requireRecord(edgeValue);
      const edgeId = requireIdentity(edge, "id");
      const edgeParentVariationId = requireIdentity(edge, "variation_id");
      const componentVariationId = requireIdentity(edge, "component_id");
      const quantity = requirePositiveInteger(edge.quantity, MAX_POSTGRES_INTEGER);
      const edgeShopId = requirePositiveInteger(edge.shop_id, MAX_POSTGRES_INTEGER);
      const component = requireRecord(edge.component);
      const nestedComponentId = requireIdentity(component, "id");
      const componentProductId = requireIdentity(component, "product_id");

      if (
        edgeIds.has(edgeId) ||
        edgeParentVariationId !== parentVariationId ||
        edgeShopId !== safeShopId ||
        nestedComponentId !== componentVariationId ||
        !isNonComposite(component.is_composite) ||
        componentVariationId === parentVariationId
      ) {
        fail();
      }
      edgeIds.add(edgeId);

      const pairKey = `${parentVariationId}\u0000${componentVariationId}`;
      if (edgePairs.has(pairKey)) fail();
      edgePairs.add(pairKey);

      parsedEdges.push({
        edgeId,
        parentVariationId,
        componentVariationId,
        componentProductId,
        quantity,
      });
    }
  }

  for (const entryValue of childEntries) {
    const entry = requireRecord(entryValue);
    const componentVariationId = requireIdentity(entry, "id");
    const componentProductId = requireIdentity(entry, "product_id");
    if (
      !isNonComposite(entry.is_composite) ||
      !Array.isArray(entry.composite_products) ||
      entry.composite_products.length !== 0 ||
      childProductByVariationId.has(componentVariationId) ||
      parentProductByVariationId.has(componentVariationId)
    ) {
      fail();
    }
    childProductByVariationId.set(componentVariationId, componentProductId);
  }

  for (const edge of parsedEdges) {
    const childProductId = childProductByVariationId.get(edge.componentVariationId);
    if (childProductId === undefined) {
      quarantinedParentIds.add(edge.parentVariationId);
    } else if (childProductId !== edge.componentProductId) {
      fail();
    }
  }

  return buildSnapshot({
    parentProductByVariationId,
    childProductByVariationId,
    edges: parsedEdges,
    quarantinedParentIds,
  });
}

/**
 * Quarantines every combo whose parent or any component is absent from the flat catalog snapshot
 * being synced — a hidden or deleted variation Pancake still lists as composite. Identity
 * contradictions are left in place for the catalog's own strict validation to reject.
 */
export function quarantineCompositesOutsideCatalog(
  snapshot: PancakeCompositeSnapshot,
  isInCatalog: (variationId: string) => boolean,
): PancakeCompositeSnapshot {
  const quarantinedParentIds = new Set(snapshot.quarantinedParentVariationIds ?? []);
  for (const parentVariationId of snapshot.parentVariationIds) {
    if (!isInCatalog(parentVariationId)) quarantinedParentIds.add(parentVariationId);
  }
  for (const edge of snapshot.edges) {
    if (!isInCatalog(edge.componentVariationId)) quarantinedParentIds.add(edge.parentVariationId);
  }
  if (quarantinedParentIds.size === (snapshot.quarantinedParentVariationIds ?? []).length) {
    return snapshot;
  }

  return buildSnapshot({
    parentProductByVariationId: new Map(
      snapshot.parentIdentities.map(({ variationId, productId }) => [variationId, productId]),
    ),
    childProductByVariationId: new Map(
      snapshot.componentIdentities.map(({ variationId, productId }) => [variationId, productId]),
    ),
    edges: snapshot.edges,
    quarantinedParentIds,
  });
}

/**
 * The snapshot without its quarantined combos: their parents and edges are dropped entirely, and a
 * component is listed only when a surviving edge uses it, so a hidden component referenced only by
 * a quarantined combo cannot fail the catalog-level checks either.
 */
function buildSnapshot({
  parentProductByVariationId,
  childProductByVariationId,
  edges,
  quarantinedParentIds,
}: {
  parentProductByVariationId: ReadonlyMap<string, string>;
  childProductByVariationId: ReadonlyMap<string, string>;
  edges: readonly PancakeCompositeEdge[];
  quarantinedParentIds: ReadonlySet<string>;
}): PancakeCompositeSnapshot {
  const keptEdges = edges.filter((edge) => !quarantinedParentIds.has(edge.parentVariationId));
  const keptParents = new Map(
    [...parentProductByVariationId].filter(([variationId]) => !quarantinedParentIds.has(variationId)),
  );
  const usedComponentIds = new Set(keptEdges.map((edge) => edge.componentVariationId));
  const keptComponents = new Map(
    [...childProductByVariationId].filter(([variationId]) => usedComponentIds.has(variationId)),
  );

  return {
    parentVariationIds: [...keptParents.keys()].sort(compareStrings),
    componentVariationIds: [...keptComponents.keys()].sort(compareStrings),
    parentIdentities: identitiesFromMap(keptParents),
    componentIdentities: identitiesFromMap(keptComponents),
    edges: keptEdges
      .map(({ parentVariationId, componentVariationId, quantity }) => ({
        parentVariationId,
        componentVariationId,
        quantity,
      }))
      .sort(compareEdges),
    quarantinedParentVariationIds: [...quarantinedParentIds].sort(compareStrings),
  };
}
