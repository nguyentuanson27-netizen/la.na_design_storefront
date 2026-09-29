type QueryValue = string | number | boolean;

type PancakeGeoReadableClient = {
  getJson(
    endpoint: string,
    query?: Readonly<Record<string, QueryValue>>,
  ): Promise<unknown>;
};

export type PancakeProvince = {
  id: string;
  name: string;
};

export type PancakeDistrict = {
  id: string;
  name: string;
  provinceId: string;
};

export type PancakeCommune = {
  id: string;
  name: string;
  provinceId: string;
  districtId: string;
};

export type PancakeGeoErrorCode = "INVALID_GEO_QUERY" | "MALFORMED_GEO_RESPONSE";

export class PancakeGeoContractError extends Error {
  readonly code: PancakeGeoErrorCode;

  constructor(code: PancakeGeoErrorCode) {
    super(code);
    this.name = "PancakeGeoContractError";
    this.code = code;
  }
}

const MAX_GEO_QUERY_ID_LENGTH = 64;
const MAX_GEO_NAME_LENGTH = 256;
const MAX_GEO_ENTRIES = 1_000;

function invalidQuery(): never {
  throw new PancakeGeoContractError("INVALID_GEO_QUERY");
}

function malformedResponse(): never {
  throw new PancakeGeoContractError("MALFORMED_GEO_RESPONSE");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireQueryId(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_GEO_QUERY_ID_LENGTH ||
    value.trim() !== value
  ) {
    invalidQuery();
  }
  return value;
}

function requireResponseId(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_GEO_QUERY_ID_LENGTH ||
    value.trim() !== value
  ) {
    malformedResponse();
  }
  return value;
}

function requireResponseName(value: unknown): string {
  if (typeof value !== "string") {
    malformedResponse();
  }
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > MAX_GEO_NAME_LENGTH) {
    malformedResponse();
  }
  return normalized;
}

function requireGeoEntries(payload: unknown): unknown[] {
  if (!isRecord(payload) || !Array.isArray(payload.data) || payload.data.length > MAX_GEO_ENTRIES) {
    malformedResponse();
  }
  return payload.data;
}

function assertUniqueId(id: string, seen: Set<string>): void {
  if (seen.has(id)) {
    malformedResponse();
  }
  seen.add(id);
}

export async function listPancakeProvinces(
  client: PancakeGeoReadableClient,
  {
    countryCode,
    isNew,
    all,
  }: {
    countryCode: string;
    isNew?: boolean;
    all?: boolean;
  },
): Promise<PancakeProvince[]> {
  const validatedCountryCode = requireQueryId(countryCode);
  if (isNew !== undefined && typeof isNew !== "boolean") {
    invalidQuery();
  }
  if (all !== undefined && typeof all !== "boolean") {
    invalidQuery();
  }

  const query: Record<string, QueryValue> = {
    country_code: validatedCountryCode,
  };
  if (isNew !== undefined) {
    query.is_new = isNew;
  }
  if (all !== undefined) {
    query.all = all;
  }

  const entries = requireGeoEntries(await client.getJson("/geo/provinces", query));
  const seen = new Set<string>();

  return entries.map((entry) => {
    if (!isRecord(entry)) {
      malformedResponse();
    }
    const id = requireResponseId(entry.id);
    assertUniqueId(id, seen);
    return {
      id,
      name: requireResponseName(entry.name),
    };
  });
}

export async function listPancakeDistricts(
  client: PancakeGeoReadableClient,
  { provinceId }: { provinceId: string },
): Promise<PancakeDistrict[]> {
  const validatedProvinceId = requireQueryId(provinceId);
  const entries = requireGeoEntries(
    await client.getJson("/geo/districts", { province_id: validatedProvinceId }),
  );
  const seen = new Set<string>();

  return entries.map((entry) => {
    if (!isRecord(entry)) {
      malformedResponse();
    }
    const id = requireResponseId(entry.id);
    const parentProvinceId = requireResponseId(entry.province_id);
    if (parentProvinceId !== validatedProvinceId) {
      malformedResponse();
    }
    assertUniqueId(id, seen);
    return {
      id,
      name: requireResponseName(entry.name),
      provinceId: parentProvinceId,
    };
  });
}

export async function listPancakeCommunes(
  client: PancakeGeoReadableClient,
  {
    provinceId,
    districtId,
  }: {
    provinceId: string;
    districtId: string;
  },
): Promise<PancakeCommune[]> {
  const validatedProvinceId = requireQueryId(provinceId);
  const validatedDistrictId = requireQueryId(districtId);
  const entries = requireGeoEntries(
    await client.getJson("/geo/communes", {
      district_id: validatedDistrictId,
      province_id: validatedProvinceId,
    }),
  );
  const seen = new Set<string>();

  return entries.map((entry) => {
    if (!isRecord(entry)) {
      malformedResponse();
    }
    const id = requireResponseId(entry.id);
    const parentProvinceId = requireResponseId(entry.province_id);
    const parentDistrictId = requireResponseId(entry.district_id);
    if (
      parentProvinceId !== validatedProvinceId ||
      parentDistrictId !== validatedDistrictId
    ) {
      malformedResponse();
    }
    assertUniqueId(id, seen);
    return {
      id,
      name: requireResponseName(entry.name),
      provinceId: parentProvinceId,
      districtId: parentDistrictId,
    };
  });
}

/**
 * The post-2025 two-level hierarchy: province → ward/commune, with no district.
 *
 * Vietnam abolished the district level on 1 July 2025 and merged provinces. Pancake serves the new
 * units from the same geo endpoints: `is_new=true` lists the new provinces, and `/geo/communes`
 * queried with a new province id (and no `district_id`) lists its wards/communes with no district
 * parent. Orders then carry `new_province_id` / `new_commune_id` instead of the old triple.
 *
 * The published OpenAPI document predates this and still marks `district_id` as required on
 * `/geo/communes`, so the shape here comes from observed Pancake behaviour; run
 * `pnpm pancake:geo:probe` with a real key to confirm it against the live shop before relying on it.
 */
export type PancakeNewProvince = PancakeProvince;

export type PancakeNewCommune = {
  id: string;
  name: string;
  provinceId: string;
};

export async function listPancakeNewProvinces(
  client: PancakeGeoReadableClient,
  { countryCode }: { countryCode: string },
): Promise<PancakeNewProvince[]> {
  return listPancakeProvinces(client, { countryCode, isNew: true });
}

export async function listPancakeNewCommunes(
  client: PancakeGeoReadableClient,
  { provinceId }: { provinceId: string },
): Promise<PancakeNewCommune[]> {
  const validatedProvinceId = requireQueryId(provinceId);
  const entries = requireGeoEntries(
    await client.getJson("/geo/communes", { province_id: validatedProvinceId }),
  );
  const seen = new Set<string>();

  return entries.map((entry) => {
    if (!isRecord(entry)) {
      malformedResponse();
    }
    const id = requireResponseId(entry.id);
    // A two-level ward has no district. One that names a district is an old-hierarchy row, which
    // cannot be submitted as a new-format address, so it fails closed rather than being mixed in.
    if (entry.district_id !== undefined && entry.district_id !== null && entry.district_id !== "") {
      malformedResponse();
    }
    if (entry.province_id !== undefined && entry.province_id !== null) {
      if (requireResponseId(entry.province_id) !== validatedProvinceId) {
        malformedResponse();
      }
    }
    assertUniqueId(id, seen);
    return {
      id,
      name: requireResponseName(entry.name),
      provinceId: validatedProvinceId,
    };
  });
}
