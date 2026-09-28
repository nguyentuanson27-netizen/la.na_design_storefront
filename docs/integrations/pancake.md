# Pancake POS integration contract

Status: **catalog read contract is implemented and verified; fingerprinted OpenAPI evidence establishes the reviewed C8 create-order structure and the T10 order-detail read shape/status enum; the server-only one-shot create-order core and guest COD checkout wiring are implemented. Native idempotency/client-reference semantics, `cod` business semantics, status transition semantics, webhook guarantees, local-state mapping, and controlled live create-order verification remain separate gates.**

## Authoritative boundaries

- Production API base: `https://pos.pages.fm/api/v1`.
- `PANCAKE_API_KEY` and `PANCAKE_SHOP_ID` are server-only configuration.
- Browser code must never receive the Pancake API key or call privileged Pancake operations directly.
- External Pancake payloads are untrusted data and must be validated before crossing the adapter boundary.
- Raw Pancake field names stay under `src/integrations/pancake/`; storefront code consumes internal types only.

Catalog endpoints used by C3:

- `GET /shops/{SHOP_ID}/products/variations`
- `GET /shops/{SHOP_ID}/warehouses`

Later order/write-path work remains separate and must not be inferred from this catalog contract.

## Trusted structural discovery

Trusted discovery runs only on a local machine with ignored `.env.local` credentials:

```bash
pnpm pancake:contract:discover
```

The command refuses CI/GitHub Actions, never retains external scalar values, normalizes array indexes to `[]`, and records observed path/type unions. It fails closed on explicit traversal budgets instead of returning partial evidence.

The product-owner rerun after PR #37 returned:

```text
format: normalized-path-types-v1
complete: true
```

for both `productVariations` and `warehouses`, with no legacy `truncated` or `max-depth` markers.

Exact field names from trusted discovery are treated as sensitive inspection material. Do not persist raw discovery output or API responses in GitHub artifacts, public logs, issues, or commits.

## Reviewed catalog contract

`src/integrations/pancake/reviewed-contract-keys.ts` contains the checked-in object-key allowlists reviewed from the trusted discovery output.

`src/integrations/pancake/catalog-contract.ts` validates and maps only the C4-facing subset currently required:

### Product/variation page

- pagination: `page_number`, `page_size`, `total_entries`, `total_pages`;
- variation identity: `id`, `product_id`, `display_id`, `barcode`;
- attributes: `fields[].id`, `fields[].keyValue`, `fields[].name`, `fields[].value`;
- images: `images[]` as raw URL strings only;
- raw flags: `is_hidden`, `is_locked`;
- raw price fields: `retail_price`, `retail_price_after_discount`;
- parent identity/presentation: `product.id`, `product.name`;
- per-warehouse inventory: `variations_warehouses[].warehouse_id`, `variations_warehouses[].remain_quantity`.

The parser:

- requires a successful response;
- validates pagination as non-negative safe integers so later sync can traverse pages deliberately;
- requires `product_id === product.id` instead of accepting inconsistent identities;
- validates the mapped field types without coercion;
- rejects duplicate `warehouse_id` rows rather than guessing whether they represent independent stock buckets;
- ignores unconsumed external fields at the internal mapped-output boundary.

`tests/fixtures/pancake/product-variations.json` and `tests/fixtures/pancake/warehouses.json` are synthetic/sanitized fixtures. They contain no live API key, real customer data, real operational inventory, or live shop identifiers.

### Website-owned variant option policy

The adapter preserves `is_hidden`, `is_locked`, `retail_price`, `retail_price_after_discount`, and attribute field values as reviewed raw contract data. It does **not** infer business meaning from arbitrary field names or descriptions.

For the storefront, the product owner explicitly approved this website-owned option policy:

- catalog sync maps only normalized `fields[].keyValue` values equal to `size` or `color`; `fields[].name` is presentation data and is not used as an authority signal;
- `size` is required for every purchasable variant;
- `color` is optional at the product level;
- when no active/present variant for a product has a mapped color, the storefront hides the Color selector and an exact Size selection is sufficient;
- when a product has a color dimension, every purchasable variant must have both Color and Size;
- duplicate Size mappings for a size-only product and duplicate Color × Size mappings for a color product fail closed as ambiguous;
- missing or conflicting mapped option values fail closed instead of guessing.

These are LA Clothing storefront rules, not claims about undocumented Pancake business semantics. Visibility policy and final storefront price selection remain separately controlled by the consuming website slice.

Image strings are also data only. C3 does not fetch remote images. Any later server-side image fetch/render integration must apply an explicit trusted-origin policy before introducing an SSRF-capable fetch boundary.

## Verified all-warehouse stock semantics

The product owner decided:

> Website sellable inventory aggregates all Pancake warehouses for each variation.

No `PANCAKE_ONLINE_WAREHOUSE_IDS` subset is used. The former explicit-subset parser/config was removed because it no longer represents the approved business rule.

Trusted discovery observed these per-warehouse quantity fields as numbers:

- `actual_remain_quantity`
- `remain_quantity`
- `total_quantity`
- `pending_quantity`
- `waiting_quantity`
- `returning_quantity`

Field names alone were not used to choose sellable stock. PR #38 added a read-only local probe:

```bash
pnpm pancake:stock:probe <variation id | display_id | barcode>
```

The command refuses CI, reads only the product/variation endpoint, validates all six quantity fields, and never creates/updates/cancels an order.

The product owner then ran a controlled quantity-1 order lifecycle against the live shop:

| Field | A → B after saving order | B → C after cancellation |
| --- | ---: | ---: |
| `actual_remain_quantity` | 0 | 0 |
| `remain_quantity` | **-1** | **+1** |
| `total_quantity` | 0 | 0 |
| `pending_quantity` | 0 | 0 |
| `waiting_quantity` | 0 | 0 |
| `returning_quantity` | 0 | 0 |

Therefore the approved MVP rule for the tested reservation lifecycle is:

```text
website sellable stock for a variation
= SUM(variations_warehouses[].remain_quantity across all distinct warehouses)
```

Mirrored stock is not a reservation. Checkout must re-read/revalidate authoritative Pancake availability immediately before order creation.

## Final reviewed-contract verification

The local verifier can now load the same ignored `.env.local` configuration:

```bash
pnpm pancake:contract:verify
```

The manual GitHub workflow `.github/workflows/pancake-contract-probe.yml` runs the same verifier with repository secrets when explicitly dispatched.

Verification has three defenses:

1. **Full allowlist validation** traverses every returned JSON node and rejects any object key not in the checked-in reviewed allowlist without echoing the unknown key.
2. **Mapped contract validation** runs the production catalog/warehouse parsers against the same live payload, validating the exact path/type subset C4 is allowed to consume, including pagination and all-warehouse `remain_quantity` aggregation.
3. **Bounded sanitized rendering** emits only reviewed field names/type shapes after validation; rendering limits cannot hide an unknown key because full validation runs first.

The full-tree allowlist validator uses a `250000`-node budget per endpoint and fails closed if the budget is exceeded.

On failure, the verifier prints only a fixed safe diagnostic code such as:

```text
Pancake reviewed-contract verification failed [stage=product-key-contract reason=inspection-budget] without logging external values or unknown field names
```

The stage distinguishes configuration, endpoint fetch, full-key validation, and mapped-contract validation for product variations vs warehouses. The reason distinguishes transport, unreviewed-field, inspection-budget, non-JSON, mapped-contract, or unexpected failure. It never echoes the API key, raw scalar values, raw payloads, or the name of an unreviewed external field.

**C3 does not become complete until this verifier passes against the current live shop payload and the resulting PR receives a clean human review.**

## C8 create-order contract verification

The current official Pancake POS Open API reference at `https://api-docs.pancake.biz/` establishes these structural facts:

- reference version `v1.0.0`;
- OpenAPI 3.1.0;
- production server `https://pos.pages.fm/api/v1`;
- Order Operations contains `POST /shops/{SHOP_ID}/orders`.

Endpoint existence alone is **not** treated as evidence for request/response semantics, a website-origin reference field, native idempotency, or the business meaning of optional monetary fields.

PR #43 added `src/integrations/pancake/order-openapi-contract.ts`, a pure local inspector for the create-order operation. It does not make network requests and does not need Pancake credentials. The inspector:

- locates exactly one `POST /shops/{...}/orders` operation without guessing the path-parameter name;
- resolves bounded local `#/...` references, including chained references;
- preserves the supported structural siblings of OpenAPI 3.1 Schema Object `$ref` values conjunctively rather than silently discarding them;
- rejects external references, unresolved references, circular references, malformed documents and inspection-budget overflow;
- uses one shared `10,000`-work-unit budget across externally controlled path entries, parameters, response entries, media types, schema nodes/arrays/properties, `$ref` hops and JSON-pointer segments so non-schema traversal cannot bypass the inspection ceiling;
- computes the effective OpenAPI parameter set by `(name, in)`, with operation-level parameters overriding matching path-level parameters; duplicate parameters within one level and path parameters without `required: true` fail closed;
- emits only structural contract metadata needed for review: parameter names/locations/required flags, schema types/formats/required property names/property structure, media types and response status structure;
- deliberately omits examples, defaults, descriptions and other external scalar sample values from its output.

The shared budget and effective-parameter rules were added after review comment `5251949190`. RED CI #432 kept 46/46 DB tests, HTTP security/authz, lint and typecheck green and failed exactly three new regressions: non-schema traversal budget, operation-over-path parameter override, and malformed duplicate/non-required path parameters. GREEN commit `0bbf5fa` passed CI #433 with 46/46 DB tests, HTTP security/authz, lint, typecheck, 151/151 domain/integration tests, production build and `admin-a11y-runtime`.

This inspector is a **discovery/review aid, not write authorization**. It intentionally captures only the structural subset needed to inspect the operation safely; it does not claim to preserve every JSON Schema/OpenAPI validation keyword.

PR #44 then captured a fingerprinted raw OpenAPI document through the bounded local evidence workflow documented in `docs/integrations/pancake-order-openapi-evidence.md`. The deterministic checked artifact `docs/integrations/pancake-order-create-contract-observed.json` establishes the create-order structural subset used by C8, including:

- required `application/json` request body;
- top-level required property `shop_id`;
- `items[]` requiring `variation_id` and `quantity`;
- integer `variation_info.retail_price` in the reviewed subset;
- selected shipping-address fields;
- documented `200` JSON response with integer `id` identity;
- `cod` exists structurally as an **optional integer**, but the evidence does not establish what value it must represent.

Therefore PR #45 does not infer `cod = merchandise subtotal + shipping fee`; the strict create-order mapper omits `cod` until trusted semantic evidence authorizes a value. The website-owned shipping policy may still populate the separately reviewed `shipping_fee` field; that policy is not evidence for `cod` semantics.

C7 also persists the source `pancakeShopId` with every new checkout snapshot. C8 requires the runtime server configuration to match that persisted scope and then uses the persisted value for live validation and order creation. The migration deliberately leaves pre-existing orders with `pancakeShopId = NULL`; those rows fail closed with `SHOP_SCOPE_UNVERIFIED` because their original shop cannot be proven. They are never backfilled from the current `PANCAKE_SHOP_ID`.

Manual review of the fingerprinted document still found no trustworthy native idempotency key, uniqueness guarantee, `request_id`, or verified website-origin reference semantics. Accordingly:

- do not treat `custom_id` as an idempotency key;
- do not perform a blind second POST after timeout/network ambiguity;
- the approved one-shot state machine remains: durable `POS_SUBMITTING` before the network call → exactly one POST attempt → definitive success `CONFIRMED`, safely classifiable local rejection `REJECTED`, ambiguous outcome `SYNC_UNKNOWN`;
- duplicate-safe retry/reconciliation remains blocked until a trustworthy unique reference/idempotency mechanism is separately verified.

No automated CI test performs a live Pancake create-order write. A controlled live create-order verification remains a separate human gate.

## T10 order-status read contract verification

The same fingerprinted Pancake OpenAPI source is now used to establish the read-only order-detail contract required by T10. The raw file remains uncommitted; `docs/integrations/pancake-order-status-contract-observed.json` is the sanitized deterministic artifact and `docs/integrations/pancake-order-status-openapi-evidence.md` documents how to reproduce it.

The checked source fingerprint is:

```text
sha256 = 44916312beb9f6d23ec96ac2ef4cf6428274ca024708f23afd19794ecddba81f
bytes  = 2774602
```

Run the local-only bounded inspector with:

```bash
pnpm pancake:order-status:inspect-openapi <local-openapi.json>
```

The evidence establishes:

- `GET /shops/{SHOP_ID}/orders/{ORDER_ID}`;
- required integer path parameter `SHOP_ID`;
- required string path parameter `ORDER_ID`;
- documented `200 application/json` response;
- selected response fields `id`, `system_id`, `shop_id`, `status`, `inserted_at`, `updated_at`;
- `id`, `system_id`, `shop_id`, `status` are integers;
- `inserted_at` and `updated_at` are `string` with `date-time` format;
- the exact structural `status` enum is:

```text
0, 17, 11, 12, 13, 20, 1, 8, 9, 2, 3, 16, 4, 15, 5, 6, 7
```

The status evidence inspector is intentionally narrower than the full order schema: it selects only those six properties, limits local-reference traversal/work, and never emits examples, descriptions, customer objects or other order PII. The production parser/gateway may validate the verified read shape and exact enum, but must not infer business semantics from enum order or numeric values.

This evidence does **not** establish the meaning of individual codes, a valid/terminal/reversible transition graph, event ordering guarantees, webhook authentication/retry/deduplication semantics, or a mapping into website-owned `LocalOrderState`. Those remain separate gates.

## Later integration contracts still unverified

These items remain intentionally unverified or separately gated:

1. Business semantics for optional `cod`; PR #45 omits it rather than guessing.
2. Correct website-origin/client-reference field and native create-order idempotency or unique-reference behavior.
3. Business meanings and allowed transition graph for the now-verified Pancake status enum, including any mapping into website `LocalOrderState`.
4. Webhook authentication/signature, retry, duplicate-delivery, replay protection and ordering guarantees. The OpenAPI states none of these, so the inventory webhook below assumes none of them.

## Inventory webhook (`variations_warehouses`)

Source: the owner-supplied Pancake POS OpenAPI document, SHA-256 `a3f5aa45ed488ab82fc8f19f006b08516b61a2c67f881078a7ed6b8477fcf044`, 2,878,785 bytes, OpenAPI `3.1.0`, `Pancake POS Open API` `1.0.0`, server `https://pos.pages.fm/api/v1` (a newer revision than the create-order evidence fingerprint above; the raw document is not committed). It establishes:

- **Configuration** (`PUT /shops/{SHOP_ID}`, `shop`): one `webhook_url` for every entry of `webhook_types` (e.g. `["orders", "customers", "variations_warehouses"]`), `webhook_enable`, and a free-form `webhook_headers` map. Our endpoint is `https://<APP_DOMAIN>/api/pancake/inventory-webhook` with the custom header `x-pancake-webhook-secret: <PANCAKE_WEBHOOK_SECRET>`.
- **Payload** (`WebhookInventoryResponse`): `{ data: { record: { variation_id, warehouse_id, remain_quantity, actual_remain_quantity, change_quantity, is_actual_remain_quantity, inserted_at, type }, success } }`. Other enabled types arrive at the same URL in other shapes (`WebhookProductResponse`, order, customer, auto-call) and are acknowledged with 200 and ignored.
- **Authoritative targeted read**: the already-reviewed `GET /shops/{SHOP_ID}/products/variations` accepts `variation_ids[]` ("Filter by variation ID"), so a targeted read is parsed by the same reviewed catalog contract as the full reconciliation.

The receiver (`src/commerce/pancake-inventory-signals.ts`) treats a delivery as a trigger only: `remain_quantity` is never read, duplicate and out-of-order deliveries collapse into one `(variation, warehouse)` marker, and the 30-second batch (`src/operations/inventory-batch.ts`) re-reads the variation from Pancake before writing. The targeted read (`src/integrations/pancake/variation-stock-read.ts`) fails closed if Pancake returns a variation that was not requested. The hourly full reconciliation remains the safety net for lost deliveries and downtime.
5. Controlled live create-order verification against the production shop.

The guest shipping-fee policy is website-owned and was approved separately by the product owner on 2026-08-11: 30,000 VND by default, with free shipping when authoritative merchandise subtotal is over 1,000,000 VND or total product quantity is at least 3. It is not an unverified Pancake API contract.

Do not guess the remaining integration contracts. In particular, do not add blind retries for uncertain Pancake order writes or map Pancake status codes into `LocalOrderState` without separate semantic evidence.

## Official sources checked

- Pancake POS full Open API reference: https://api-docs.pancake.biz/
- Pancake POS Open API reference entry: https://docs.pancake.biz/pos/api/en/
- Pancake POS Open API overview: https://docs.pancake.biz/pos/st-f13/st-p1?lang=en
- API key/authentication: https://docs.pancake.biz/pos/st-f13/st-p2?lang=en
- Order status & processing flow: https://docs.pancake.biz/pos/st-f13/st-p3?lang=en
- OpenAPI 3.1.0 specification: https://spec.openapis.org/oas/v3.1.0
- pnpm run argument forwarding: https://pnpm.io/cli/run
