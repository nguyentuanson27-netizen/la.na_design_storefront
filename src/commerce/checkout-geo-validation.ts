import { parseGuestCheckoutInput } from "./guest-checkout-input.ts";
import type {
  PancakeCommune,
  PancakeDistrict,
  PancakeProvince,
} from "../integrations/pancake/geo.ts";

type CheckoutGeoValidationDependencies = Readonly<{
  loadProvinces(): Promise<PancakeProvince[]>;
  loadDistricts(provinceId: unknown): Promise<PancakeDistrict[]>;
  loadCommunes(provinceId: unknown, districtId: unknown): Promise<PancakeCommune[]>;
}>;

const INVALID_INPUT = Object.freeze({
  ok: false as const,
  reason: "INVALID_INPUT" as const,
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
    return INVALID_INPUT;
  }

  const { provinceRef, districtRef, communeRef } = parsed.value;

  // All three levels are named by the input, so all three reads start together: the buyer waits for
  // the slowest one rather than their sum. They are still *judged* top-down, so an unknown province
  // is INVALID_INPUT even if the district read for that bogus province failed, and an outage at a
  // level is only reported once every level above it has been confirmed.
  const provincesRead = settle(dependencies.loadProvinces());
  const districtsRead = settle(dependencies.loadDistricts(provinceRef));
  const communesRead = settle(dependencies.loadCommunes(provinceRef, districtRef));

  const provinces = unwrap(await provincesRead);
  if (!provinces.some((province) => province.id === provinceRef)) {
    return INVALID_INPUT;
  }

  const districts = unwrap(await districtsRead);
  if (!districts.some((district) => district.id === districtRef)) {
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
