import {
  listPancakeNewCommunes,
  listPancakeNewProvinces,
  PancakeGeoContractError,
  type PancakeNewCommune,
  type PancakeNewProvince,
} from "../integrations/pancake/geo.ts";

/**
 * The address hierarchy checkout offers: the post-2025 two levels, province → ward/commune.
 * The street and house number are typed by the buyer.
 */

type QueryValue = string | number | boolean;

type CheckoutGeoReadableClient = {
  getJson(
    endpoint: string,
    query?: Readonly<Record<string, QueryValue>>,
  ): Promise<unknown>;
};

export type CheckoutProvince = PancakeNewProvince;
export type CheckoutCommune = PancakeNewCommune;

function requireParentId(value: unknown): string {
  if (typeof value !== "string") {
    throw new PancakeGeoContractError("INVALID_GEO_QUERY");
  }
  return value;
}

export async function loadCheckoutProvinces(
  client: CheckoutGeoReadableClient,
): Promise<CheckoutProvince[]> {
  return listPancakeNewProvinces(client, { countryCode: "84" });
}

export async function loadCheckoutCommunes(
  client: CheckoutGeoReadableClient,
  provinceId: unknown,
): Promise<CheckoutCommune[]> {
  return listPancakeNewCommunes(client, { provinceId: requireParentId(provinceId) });
}
