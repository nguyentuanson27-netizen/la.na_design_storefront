/**
 * The one answer to "which sizes speak for a product's price and availability".
 *
 * A parent-level listing (Google/Meta feed row, the unselected product page) has to quote ONE price
 * and ONE availability for several size/colour options. Quoting the cheapest of all of them while
 * reporting `in_stock` because a different one is available advertises a price nobody can buy, and
 * quoting a different set on the page than in the feed is exactly the price mismatch Google refuses.
 * Both read this function so they cannot drift apart.
 *
 * Preference follows what a shopper can actually order: in-stock options, else dated backorder
 * options, else (nothing orderable) every priced option, which keeps a sold-out product's lowest
 * listed price rather than hiding it.
 */
import type { ExternalAvailability } from "./availability-projection.ts";

export type RepresentativeOfferCandidate = Readonly<{
  price: number | null;
  purchasable: boolean;
  availability: ExternalAvailability;
}>;

export type RepresentativeOffers<TOption extends RepresentativeOfferCandidate> = Readonly<{
  availability: "in_stock" | "backorder" | "out_of_stock";
  /** Every option in the winning class. A page quotes the range over these. */
  offered: readonly TOption[];
  /**
   * One option that speaks for a single-offer surface such as a feed row: the cheapest of `offered`,
   * ties broken by the earlier availability date, so price and date describe the same option.
   * Null only when no option has a usable price.
   */
  representative: TOption | null;
  /** The representative's backorder date; null for every other class. */
  availabilityDate: string | null;
}>;

function pricedOptions<TOption extends RepresentativeOfferCandidate>(options: readonly TOption[]) {
  return options.filter(
    (option) => typeof option.price === "number" && Number.isFinite(option.price) && option.price > 0,
  );
}

function backorderDate(option: RepresentativeOfferCandidate): string | null {
  return option.availability.published && option.availability.merchant === "backorder"
    ? option.availability.availabilityDate
    : null;
}

export function selectRepresentativeOffers<TOption extends RepresentativeOfferCandidate>(
  options: readonly TOption[],
): RepresentativeOffers<TOption> {
  const priced = pricedOptions(options);
  const orderable = priced.filter((option) => option.purchasable && option.availability.published);

  const inStock = orderable.filter(
    (option) => option.availability.published && option.availability.merchant === "in_stock",
  );
  const backordered = orderable.filter((option) => backorderDate(option) !== null);

  const [availability, offered] =
    inStock.length > 0
      ? (["in_stock", inStock] as const)
      : backordered.length > 0
        ? (["backorder", backordered] as const)
        : (["out_of_stock", priced] as const);

  const representative =
    [...offered].sort((a, b) => {
      const byPrice = (a.price as number) - (b.price as number);
      if (byPrice !== 0) return byPrice;
      const dateA = backorderDate(a) ?? "";
      const dateB = backorderDate(b) ?? "";
      return dateA < dateB ? -1 : dateA > dateB ? 1 : 0;
    })[0] ?? null;

  return Object.freeze({
    availability,
    offered,
    representative,
    availabilityDate: availability === "backorder" && representative ? backorderDate(representative) : null,
  });
}
