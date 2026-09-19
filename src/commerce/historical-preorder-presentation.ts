import { FULFILLMENT } from "../brand/index.ts";
import { PREORDER_LABEL } from "./preorder-fulfillment-presentation.ts";

export type HistoricalPreorderSnapshotFacts = Readonly<{
  confirmedAt: Date;
  preorderReadyAt: Date | null;
  shippingInnerCityMinDays: number | null;
  shippingInnerCityMaxDays: number | null;
  shippingOtherProvinceMinDays: number | null;
  shippingOtherProvinceMaxDays: number | null;
  lines: readonly Readonly<{
    variantId: string;
    quantity: number;
    state: "READY" | "PREORDER";
    preorderReadyAt: Date | null;
  }>[];
}>;

export type HistoricalShippingWindow = Readonly<{
  zoneLabel: string;
  minimumDays: number;
  maximumDays: number;
}>;

export type HistoricalPreorderPresentation = Readonly<{
  preorderLabel: string;
  preorderReadyAt: string;
  isMixedReadyAndPreorder: boolean;
  shippingWindows: readonly HistoricalShippingWindow[] | null;
  estimateCaveat: string;
}>;

function validDate(value: Date | null): value is Date {
  return value instanceof Date && !Number.isNaN(value.getTime());
}

function validRange(minimum: number | null, maximum: number | null): boolean {
  return (
    Number.isSafeInteger(minimum) &&
    minimum !== null &&
    minimum > 0 &&
    Number.isSafeInteger(maximum) &&
    maximum !== null &&
    maximum >= minimum
  );
}

/**
 * F8c — buyer-safe projection of immutable I7 history.
 *
 * This function deliberately accepts only persisted I7 facts. It never reads stock, selling policy,
 * Merchant availability, catalog visibility, or a live delivery estimate. The only live brand facts
 * it uses are presentation labels and the estimate caveat; the numerical windows shown to a buyer
 * come exclusively from the confirmation-time snapshot.
 *
 * A legacy I7 row may predate F8c and therefore have no shipping numbers. In that case preorder
 * history still renders, but shipping is omitted rather than reconstructed from today's A5 policy.
 */
export function buildHistoricalPreorderPresentation(
  snapshot: HistoricalPreorderSnapshotFacts | null,
): HistoricalPreorderPresentation | null {
  if (!snapshot || snapshot.lines.length === 0) return null;

  const preorderLines = snapshot.lines.filter((line) => line.state === "PREORDER");
  if (preorderLines.length === 0 || !validDate(snapshot.preorderReadyAt)) return null;

  const readyAtMs = snapshot.preorderReadyAt.getTime();
  for (const line of snapshot.lines) {
    if (
      !Number.isSafeInteger(line.quantity) ||
      line.quantity <= 0 ||
      (line.state === "PREORDER" &&
        (!validDate(line.preorderReadyAt) || line.preorderReadyAt.getTime() !== readyAtMs)) ||
      (line.state === "READY" && line.preorderReadyAt !== null)
    ) {
      return null;
    }
  }

  const hasAllShippingFacts =
    validRange(snapshot.shippingInnerCityMinDays, snapshot.shippingInnerCityMaxDays) &&
    validRange(snapshot.shippingOtherProvinceMinDays, snapshot.shippingOtherProvinceMaxDays);

  const hasNoShippingFacts =
    snapshot.shippingInnerCityMinDays === null &&
    snapshot.shippingInnerCityMaxDays === null &&
    snapshot.shippingOtherProvinceMinDays === null &&
    snapshot.shippingOtherProvinceMaxDays === null;

  if (!hasAllShippingFacts && !hasNoShippingFacts) return null;

  const shippingWindows = hasAllShippingFacts
    ? Object.freeze([
        Object.freeze({
          zoneLabel: FULFILLMENT.deliveryScopeLabels.innerCity,
          minimumDays: snapshot.shippingInnerCityMinDays!,
          maximumDays: snapshot.shippingInnerCityMaxDays!,
        }),
        Object.freeze({
          zoneLabel: FULFILLMENT.deliveryScopeLabels.otherProvince,
          minimumDays: snapshot.shippingOtherProvinceMinDays!,
          maximumDays: snapshot.shippingOtherProvinceMaxDays!,
        }),
      ])
    : null;

  return Object.freeze({
    preorderLabel: PREORDER_LABEL,
    preorderReadyAt: snapshot.preorderReadyAt.toISOString(),
    isMixedReadyAndPreorder: snapshot.lines.some((line) => line.state === "READY"),
    shippingWindows,
    estimateCaveat: FULFILLMENT.delivery.estimateCaveat,
  });
}
