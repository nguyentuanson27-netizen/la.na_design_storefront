# Pancake geo OpenAPI evidence

Status: **the fingerprinted Pancake POS OpenAPI document establishes the structural province → district → commune read contract, and the first strict read-only server gateway has been implemented against that evidence. The product policy for Vietnam old/new administrative identifiers remains intentionally separate from this low-level contract.**

## Source fingerprint

The supplied raw JSON has the same fingerprint already used by the reviewed create-order evidence workflow:

- SHA-256 `44916312beb9f6d23ec96ac2ef4cf6428274ca024708f23afd19794ecddba81f`;
- size `2,774,602` bytes;
- OpenAPI `3.1.0`;
- title `Pancake POS Open API`;
- version `1.0.0`;
- production server `https://pos.pages.fm/api/v1`;
- API authentication: query parameter `api_key`.

The raw external document is not committed. The checked-in `pancake-geo-contract-observed.json` contains only the sanitized structural subset needed for review and implementation.

## Machine-derived geo contract

### Provinces

`GET /geo/provinces`

Query parameters:

- `country_code: string` — required;
- `is_new: boolean` — optional;
- `all: boolean` — optional.

HTTP `200` JSON shape:

```text
{
  data: Array<{
    id: string
    name: string
    name_en?: string
    new_id?: string
  }>
}
```

### Districts

`GET /geo/districts`

Query parameters:

- `province_id: string` — required.

HTTP `200` JSON shape:

```text
{
  data: Array<{
    id: string
    name: string
    name_en?: string
    province_id: string
  }>
}
```

### Communes

`GET /geo/communes`

Query parameters:

- `district_id: string` — required;
- `province_id: string` — required.

HTTP `200` JSON shape:

```text
{
  data: Array<{
    id: string
    name: string
    name_en?: string
    district_id: string
    province_id: string
    new_id?: string
    postcode?: string
  }>
}
```

The important contract correction versus the earlier unknown state is that commune lookup requires **both** the selected district ID and its province ID.

## Manual semantic review

The raw document describes:

- `country_code=84` as Vietnam;
- `province_id` for district lookup as the province ID returned by `GET /geo/provinces`;
- `district_id` and `province_id` for commune lookup as IDs returned by the preceding geo reads;
- province `is_new` as “New province (for country Viet Nam)”;
- province `all` as including old and new provinces;
- `new_id` fields on province/commune records.

The document therefore exposes an administrative-version choice for Vietnam. This evidence does **not** establish which old/new mode LA Clothing should present to shoppers, nor that a mixed old/new hierarchy is valid. The low-level gateway preserves the documented parameters without silently choosing that product policy.

The raw commune example also shows `new_id` and `postcode` as `null` even though their structural schema says `string`. Checkout does not need those fields, so the first production parser deliberately does not expose them instead of widening the public contract around inconsistent optional metadata.

## Gateway implementation constraints

The server-side gateway built from this evidence must:

- keep `api_key` server-only through the existing `PancakeClient`;
- build only the three fixed geo paths above;
- require explicit caller input for documented lookup parameters;
- validate third-party response payloads before returning data;
- expose only IDs/names and parent IDs required for hierarchy selection;
- reject malformed, duplicate or wrong-parent records instead of silently repairing them;
- remain read-only and perform no Pancake write;
- not treat examples/default values as browser authority.

## Implemented gateway boundary

`src/integrations/pancake/geo.ts` now implements the evidence-backed read boundary:

- province lookup always requires an explicit `countryCode`; optional `isNew` / `all` flags are omitted unless the caller deliberately supplies them;
- district lookup sends exactly `province_id`;
- commune lookup sends exactly both `district_id` and `province_id`;
- lookup identifiers must be non-empty, already-trimmed strings no longer than 64 characters before any network read;
- third-party response `data` must be an array of at most 1,000 entries;
- response IDs must be non-empty, already-trimmed strings no longer than 64 characters;
- display names are trimmed and bounded to 256 characters;
- duplicate IDs, malformed rows and parent-ID mismatches fail closed as `MALFORMED_GEO_RESPONSE`;
- only the hierarchy fields required by checkout are returned; `name_en`, `new_id`, `postcode` and unknown external fields are not propagated.

The gateway uses the existing `PancakeClient` read method, which owns the fixed Pancake base URL, server-side `api_key`, timeout, redirect rejection and URL query encoding. No Pancake write is introduced by this slice.

## TDD evidence

- Clean RED: commit `7dfaed771ec0792da50cc69a43c31fee049030f9`, CI **#549 / 31579419917**. Database 64/64, all three HTTP smokes, lint and admin accessibility passed; typecheck failed only because `src/integrations/pancake/geo.ts` did not exist.
- GREEN gateway implementation: commit `8079813f3ba5c8714642f744b735cfd47c3721c2`, CI **#550 / 31579737424**. Database, all three HTTP smokes, lint, typecheck, full domain/integration tests, production build and admin accessibility all passed.
- A follow-up regression also verifies that non-boolean province-mode values are rejected at runtime when a JavaScript caller bypasses TypeScript. The final PR-head CI must remain green after that test and this documentation update.

## Checkout policy: post-2025 two-level address

The owner has made the old/new policy explicit: checkout offers **only** the post-1 July 2025 units,
province → ward/commune, then the buyer types the house number and street. There is no district.

What checkout does, and where each part comes from:

- provinces: `GET /geo/provinces?country_code=84&is_new=true` (the documented `is_new` flag);
- wards/communes: `GET /geo/communes?province_id=<new province id>` with **no** `district_id`. The
  fingerprinted OpenAPI document above still marks `district_id` as required, so this call is not
  covered by it; it follows Pancake's observed behaviour (a new-format province id such as
  `84_VN101` returns two-level rows with `district_id: null`). `listPancakeNewCommunes` fails closed
  on any row that names a district or a different province;
- create order: `shipping_address.new_province_id` / `new_commune_id` instead of the
  `province_id` / `district_id` / `commune_id` triple, which is likewise observed rather than in the
  reviewed create-order evidence;
- `OrderMirror.districtRef` is `NULL` for a two-level checkout. A draft snapshotted before the switch
  still carries its district and is still submitted with the old triple.

Because two of those contracts are observed rather than documented, confirm them on the live shop
before release: `pnpm pancake:geo:probe` (read-only) must pass, and one real COD test order must
show the ward/commune correctly in Pancake.
