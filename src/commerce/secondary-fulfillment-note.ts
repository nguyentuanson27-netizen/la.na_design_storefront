import type { PancakeCatalogVariation } from "../integrations/pancake/catalog-contract.ts";

/**
 * The staff note naming what must be moved out of the secondary shop's warehouses, or `null` when
 * the primary shop's own stock covers the order.
 *
 * Demand is summed per Pancake variation across every line and combo component BEFORE it is set
 * against stock: the capacity gate judges the order on that total, so a standalone unit and a combo
 * that both need the same article draw on the primary stock together. Judging each resource alone
 * would let each one "fit" in the primary stock and leave the shortfall out of the note.
 *
 * Units other orders hold that Pancake's stock does not show yet (`heldElsewhere`) have a prior
 * claim on the primary stock, exactly as the capacity gate counts them: this order is allotted what
 * primary stock they leave, and the rest comes from the secondary shop. The earlier order, judged
 * when nothing was held, took the primary unit and has no note; the later one gets it.
 */
export function buildSecondaryFulfillmentTag(
  resources: Iterable<Readonly<{ pancakeVariationId: string; units: number; heldElsewhere?: number }>>,
  liveByVariationId: ReadonlyMap<string, PancakeCatalogVariation | null>,
): string | null {
  const unitsByVariation = new Map<string, number>();
  // Held units belong to the variation, not to the resource, so they are not summed across the
  // resources that share one; the largest figure any of them carries stands.
  const heldByVariation = new Map<string, number>();
  for (const { pancakeVariationId, units, heldElsewhere } of resources) {
    unitsByVariation.set(pancakeVariationId, (unitsByVariation.get(pancakeVariationId) ?? 0) + units);
    heldByVariation.set(
      pancakeVariationId,
      Math.max(heldByVariation.get(pancakeVariationId) ?? 0, heldElsewhere ?? 0),
    );
  }

  const fromSecondaryBySku = new Map<string, number>();
  for (const [pancakeVariationId, units] of unitsByVariation) {
    const live = liveByVariationId.get(pancakeVariationId);
    const secondaryStock = live?.secondarySellableStock ?? 0;
    if (!live || secondaryStock <= 0) continue;

    const primaryLeft = Math.max(0, (live.primarySellableStock ?? 0) - (heldByVariation.get(pancakeVariationId) ?? 0));
    const unitsFromSecondary = Math.min(Math.max(0, units - primaryLeft), secondaryStock);
    if (unitsFromSecondary <= 0) continue;

    const sku = live.displayId ?? pancakeVariationId;
    fromSecondaryBySku.set(sku, (fromSecondaryBySku.get(sku) ?? 0) + unitsFromSecondary);
  }
  if (fromSecondaryBySku.size === 0) return null;

  const parts = [...fromSecondaryBySku].map(([sku, quantity]) => `SKU ${sku} x${quantity}`);
  return `[Xuất kho phụ: ${parts.join(", ")}]`;
}
