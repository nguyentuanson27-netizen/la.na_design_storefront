import { parseGuestCheckoutInput } from "./guest-checkout-input.ts";
import type { CheckoutCommune, CheckoutProvince } from "./checkout-geo.ts";

type CheckoutGeoValidationDependencies = Readonly<{
  loadProvinces(): Promise<CheckoutProvince[]>;
  loadCommunes(provinceId: unknown): Promise<CheckoutCommune[]>;
}>;

const INVALID_INPUT = Object.freeze({
  ok: false as const,
  reason: "INVALID_INPUT" as const,
});

const INVALID_PHONE = Object.freeze({
  ok: false as const,
  reason: "INVALID_PHONE" as const,
});

type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown };

/** Holds a read's outcome without letting an unexamined rejection go unhandled. */
function settle<T>(read: Promise<T>): Promise<Settled<T>> {
  return read.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
}

function unwrap<T>(result: Settled<T>): T {
  if (!result.ok) throw result.error;
  return result.value;
}

export async function validateCheckoutGeoSelection(
  dependencies: CheckoutGeoValidationDependencies,
  input: unknown,
) {
  const parsed = parseGuestCheckoutInput(input);
  if (!parsed.ok) {
    return parsed.reason === "INVALID_PHONE" ? INVALID_PHONE : INVALID_INPUT;
  }

  const { provinceRef, communeRef } = parsed.value;

  // Both levels are named by the input, so both reads start together: the buyer waits for the
  // slower one rather than their sum. They are still *judged* top-down, so an unknown province is
  // INVALID_INPUT even if the commune read for that bogus province failed, and an outage at the
  // commune level is only reported once the province has been confirmed.
  const provincesRead = settle(dependencies.loadProvinces());
  const communesRead = settle(dependencies.loadCommunes(provinceRef));

  const provinces = unwrap(await provincesRead);
  if (!provinces.some((province) => province.id === provinceRef)) {
    return INVALID_INPUT;
  }

  const communes = unwrap(await communesRead);
  if (!communes.some((commune) => commune.id === communeRef)) {
    return INVALID_INPUT;
  }

  return {
    ok: true as const,
    checkoutInput: parsed.value,
  };
}
