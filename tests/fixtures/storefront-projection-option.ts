import {
  projectExternalAvailability,
  type ExternalAvailability,
} from "../../src/commerce/availability-projection.ts";
import type { CapacityDecisionReason } from "../../src/commerce/capacity-policy.ts";
import type { StorefrontProjectionOption } from "../../src/commerce/storefront-projection.ts";

/**
 * I9 — fill a fixture's external availability from the option it already describes.
 *
 * `availability` is required on a projection option because it is a published product fact, so
 * every construction site has to mean it. That is right for production and pure noise in a fixture
 * about something else, which is what this exists for.
 *
 * It **derives** the value through the real projection rather than hard-coding one, so a fixture
 * can never quietly assert an availability the shipped mapping would not produce. Fixtures that are
 * actually about availability pass their own dates.
 */
export function fixtureAvailability(
  option: Pick<StorefrontProjectionOption, "purchasable" | "isPreorderSale" | "unavailableReason">,
  dates: Readonly<{
    availabilityDate?: string | null;
    today?: string | null;
    /** For fixtures that are about an unreadable catalog rather than an ordinary sell-out. */
    capacityReason?: CapacityDecisionReason;
  }> = {},
): ExternalAvailability {
  return projectExternalAvailability({
    purchasable: option.purchasable,
    isPreorderSale: option.isPreorderSale,
    unavailableReason: option.unavailableReason,
    // A fixture that says `purchasable: false` with `OUT_OF_STOCK` means an ordinary sold-out
    // variant; anything else it says is already carried by `unavailableReason`.
    capacityReason:
      dates.capacityReason ??
      (option.purchasable ? "capacity-available" : "standard-would-go-negative"),
    availabilityDate: dates.availabilityDate ?? null,
    today: dates.today ?? null,
  });
}

/** Add the derived availability to one fixture option literal. */
export function withFixtureAvailability<
  T extends Omit<StorefrontProjectionOption, "availability">,
>(option: T): T & { availability: ExternalAvailability } {
  return { ...option, availability: fixtureAvailability(option) };
}

/** Add the derived availability to a list of fixture option literals. */
export function withFixtureAvailabilities<
  T extends Omit<StorefrontProjectionOption, "availability">,
>(options: readonly T[]): (T & { availability: ExternalAvailability })[] {
  return options.map(withFixtureAvailability);
}
