import type { CheckoutCommune, CheckoutProvince } from "./checkout-geo.ts";

type CheckoutGeoPublicFailure = Readonly<{
  ok: false;
  reason: "GEO_UNAVAILABLE";
}>;

type CheckoutGeoPublicSuccess<T> = Readonly<{
  ok: true;
  options: T[];
}>;

export type CheckoutGeoPublicResult<T> =
  | CheckoutGeoPublicSuccess<T>
  | CheckoutGeoPublicFailure;

type CheckoutGeoPublicDependencies = Readonly<{
  allowRead(): Promise<boolean>;
  loadProvinces(): Promise<CheckoutProvince[]>;
  loadCommunes(provinceId: unknown): Promise<CheckoutCommune[]>;
}>;

const GEO_UNAVAILABLE: CheckoutGeoPublicFailure = Object.freeze({
  ok: false,
  reason: "GEO_UNAVAILABLE",
});

async function safeRead<T>(
  dependencies: CheckoutGeoPublicDependencies,
  read: () => Promise<T[]>,
): Promise<CheckoutGeoPublicResult<T>> {
  try {
    if (!(await dependencies.allowRead())) {
      return GEO_UNAVAILABLE;
    }
    return {
      ok: true,
      options: await read(),
    };
  } catch {
    return GEO_UNAVAILABLE;
  }
}

export function createCheckoutGeoPublicActions(
  dependencies: CheckoutGeoPublicDependencies,
) {
  return {
    provinces(): Promise<CheckoutGeoPublicResult<CheckoutProvince>> {
      return safeRead(dependencies, () => dependencies.loadProvinces());
    },
    communes(provinceId: unknown): Promise<CheckoutGeoPublicResult<CheckoutCommune>> {
      return safeRead(dependencies, () => dependencies.loadCommunes(provinceId));
    },
  };
}
