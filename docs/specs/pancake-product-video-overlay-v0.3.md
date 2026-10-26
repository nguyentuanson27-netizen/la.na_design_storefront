# Spec v0.3 - Pancake variation video -> La.Na PDP overlay

Status: **Ready for implementation planning, subject to owner approval. Not ready for production release.**
Date: 2026-10-26 (Asia/Bangkok)
Repo: `nguyentuanson27-netizen/la.na_design_storefront`
Source baseline: `main@12f140a590d450793229a4e25f9602a4ab1f2dd7` (read on 2026-10-26). Supersedes v0.2 regarding the location and type of Pancake video data.

## 1. Objective and strict scope

Display **at most one "Xem video" preview tile** at the bottom-right of the main product photo on `/shop/[slug]`, in the position inspired by the provided Shopee "Xem Live" screenshot. Clicking opens a modal with a native HTML video player. Video is pre-recorded, not a livestream. Do not move video into the photo gallery, change photo counters, alter `galleryIndexByVariantId`, add admin uploads/manual links, proxy media through Next.js, change price/inventory/order logic, or add another API polling job.

Source of truth: Pancake POS. Persist only a trusted URL and minimal video-sync state in the website's source mirror; never copy video bytes to the database or VPS. No video means no tile; all other product behavior remains unchanged.

## 2. Evidence status - important distinction

### Agent-reported live API probe (not independently reproduced here)

- Product-variation list: `GET /shops/{SHOP_ID}/products/variations`, 6,851 variations / 69 pages were reportedly inspected.
- Path and shape: `data[].videos` is `string[] | null`; `data[].product.videos` is absent. The video belongs to a **variation**, not the nested parent product.
- Product detail: `GET /shops/{SHOP_ID}/products/{PRODUCT_SKU}` reportedly returns `{success:true,data:{...}}`; `data.variations[].videos` holds the same data, while `data.videos` is absent. This wrapper differs from the bundled OpenAPI schema representation.
- Reported coverage: 463 video-bearing variations belonging to 137 products; 130 products share one URL across their video-bearing variations, and 7 have distinct URLs (often by color). Some arrays contain 2-3 links.
- Media observed: HTTPS `content.pancake.vn`, paths shaped `/<segment>/<year>/<month>/<day>/<filename>.mp4` and `.mov`; the report includes examples of both types.
- HTTP HEAD: reportedly 200, video MIME, `Accept-Ranges: bytes`. HEAD alone does not prove 206 behavior or successful decoding in each browser.
- No actual live add/delete mutation was performed. Seeing `videos:null` on different products does **not** prove the time-to-reflect of add/delete actions.

### Verified against code/static source

- `src/integrations/pancake/reviewed-contract-keys.ts` already allowlists the `videos` key.
- `src/integrations/pancake/catalog-contract.ts` does not parse or return it.
- `src/commerce/product-media.ts` includes `parseTrustedProductVideoUrl()` for HTTPS `content.pancake.vn` URLs ending in `.mp4` with reviewed path shape.
- The two provided `.mp4` sample paths match the reviewed legacy path regular expression; the `.mov` path does not. This was checked locally against that expression, not by running the complete application.
- The existing full catalog sync loop defaults to 3,600 seconds if its environment is not customized. The actual production interval and end-to-end freshness remain to be checked.
- `api-1.json` does not define the video extension; the live agent report is evidence for an undocumented API field, not a change to the public OpenAPI specification.

## 3. Proposed domain contract

Read **only** `variation.videos`, never `variation.product.videos`. The optional video parser must not fail a commerce-valid variation, its price, or stock. **Missing or malformed video data is not equivalent to explicit no-video.**

Classify the video field on **each variation** before product aggregation:

| Source observation | Video evidence | Meaning |
| --- | --- | --- |
| Own `videos` field explicitly `null` or `[]` | `EMPTY` | Valid observation of no video |
| Own `videos` is a nonempty bounded array of trusted, valid source URL strings | `URLS` | Candidate(s), not yet approved product-wide |
| Field missing; wrong type; invalid array element; too many entries; overlong, malformed, or untrusted URL | `UNKNOWN` | Video status undetermined; **never** treat as `EMPTY` |

Bound the array to **8 URLs per variation**, and each URL to **4,096 characters**. A malformed member makes that variation `UNKNOWN`; never silently filter it to `[]`. Deduplicate **exact normalized URLs** independent of API order.

MP4 must pass the existing `parseTrustedProductVideoUrl()` (HTTPS, exact `content.pancake.vn`, reviewed path, no credentials, custom port, traversal or other extension). Recognize valid Pancake `.mov` **only as source evidence** under equivalent strict origin/path checks, so it can trigger conflict/unsupported handling; do **not** widen the browser player allowlist or label MOV as `video/mp4`. Other untrusted hosts/extensions or malformed values are `UNKNOWN`. Never pass raw `videos` to client code.

## 4. Choosing one video per product (deterministic MVP policy)

This is one **product-wide** tile, not per-color/per-variation playback. Use **every variation** returned for that product from a single complete, successfully validated shop-wide paginated snapshot, including hidden/locked/out-of-stock variations. Do not select only video-bearing variations, infer coverage from the reported 130/137 figure, or rely on API ordering.

**Precedence (exactly one outcome per product):**

1. Classify every variation as `EMPTY`, `URLS`, or `UNKNOWN` using `3. Only recognized trusted MP4/MOV URLs count as definite nonempty source evidence.
2. **Known `CONFLICT` takes precedence:** two or more **distinct** normalized trusted source URLs anywhere in the product (including different links in one array), **or** at least one trusted `URLS` and one explicit `EMPTY` variation. This proves product-wide video is nonuniform even if a third variation is `UNKNOWN`. **Clear previous URL; hide tile.**
3. Otherwise, **any `UNKNOWN` => product `UNKNOWN`**. Retain previously mirrored URL **but hide tile** until a later complete, conclusive snapshot. Missing/malformed is never an implicit deletion.
4. Otherwise, **all `EMPTY` => `NONE`**: clear old URL and hide tile.
5. Otherwise, every variation has `URLS` and all normalize to **one identical trusted source URL**. If the URL passes the existing MP4 validator => `READY`: store it and show one tile. If the sole URL is a trusted MOV => `UNSUPPORTED`: clear old URL and hide tile.
6. If complete variation coverage cannot be established, no `READY` or clearing action is authorized. No owner judgment or color guessing is permitted in MVP.

**Partial coverage is a deterministic `CONFLICT`:** a video on S/M but `null` or `[]` on L/XL, or one color with video and another without, **always clears the URL and hides the tile**. Only explicit video on **all** variations with the same MP4 qualifies as product-wide.

| Observed variation videos (complete snapshot) | Product state | Stored URL | PDP |
| --- | --- | --- | --- |
| `[A.mp4]` / `[A.mp4]` / `[A.mp4]`, trusted | `READY` | A | Show |
| `null` / `[]` / `null` | `NONE` | Clear | Hide |
| `[A.mp4]` / `null` | `CONFLICT` | Clear | Hide |
| `[A.mp4]` / `[B.mp4]` | `CONFLICT` | Clear | Hide |
| `[A.mp4,B.mp4]` in one variation | `CONFLICT` | Clear | Hide |
| `[A.mp4]` / field missing | `UNKNOWN` | **Keep old** | Hide |
| `[A.mp4]` / malformed array | `UNKNOWN` | **Keep old** | Hide |
| `[A.mp4]` / `null` / missing | `CONFLICT` (known mismatch wins) | Clear | Hide |
| `[A.mov]` / `[A.mov]`, trusted | `UNSUPPORTED` | Clear | Hide |
| `null` / `null` / missing | `UNKNOWN` | **Keep old** | Hide |

A later **separately approved** version may switch the tile based on color/variation selection; that is out of MVP scope.

## 5. Persistence and sync

Persist one trusted URL **and its minimal evidence state** in source-owned `ProductMirror` (never website-owned `ProductContent`). Proposed additive Prisma schema:

```prisma
enum PancakeVideoSyncState {
  UNKNOWN
  READY
  NONE
  CONFLICT
  UNSUPPORTED
}

model ProductMirror {
  // all existing fields stay unchanged
  pancakeVideoUrl       String?
  pancakeVideoSyncState PancakeVideoSyncState @default(UNKNOWN)
}
```

Existing products start at `UNKNOWN` after migration; this does not claim they have no video. Update the URL and state **atomically** on the product mirror create/update/reactivation path, preserving shop isolation and idempotence. Optional video errors must never block valid stock/price/catalog reconciliation.

| Complete commerce-valid snapshot outcome | URL action | State action |
| --- | --- | --- |
| `READY` | Set trusted MP4 | `READY` |
| `NONE`, `CONFLICT`, `UNSUPPORTED` | Set `null` | Corresponding state |
| `UNKNOWN` (missing, malformed, untrusted, inconclusive coverage) | **Preserve previous URL** | `UNKNOWN` |

**Hard display gate:** the server returns a video only when flag ON **and** `pancakeVideoSyncState === READY` **and** `pancakeVideoUrl` re-passes the trusted MP4 validator. A URL retained in `UNKNOWN` must **never** be sent to HTML/JSON as playable video. `CONFLICT` and `UNSUPPORTED` cannot display an old URL.

Failed/incomplete page fetch => **no snapshot commit and no video state transition**. Complete commerce-valid snapshot with malformed/missing optional `videos` still syncs price/stock, but marks affected products `UNKNOWN` without clearing their old URL. `READY -> NONE/CONFLICT/UNSUPPORTED` clears stale URL **only on conclusive observed variation evidence**; `READY -> UNKNOWN` preserves the stored URL but **hides it**. A later complete valid snapshot can restore `READY` or clear it. No partial per-page video updates.

Emit only aggregate state/reason counters (`partial_coverage`, `multi_url`, `mov_only`, `missing`, `malformed`, `untrusted`). Do not log video URLs, API keys, customer information, or raw payloads. An actual add/remove transition test remains a release gate; the read-only probe did not establish instant deletion propagation.

## 6. Read model and UI

- Server route returns a validated optional `{src, poster}` object **only** if the feature flag is ON and `pancakeVideoSyncState === READY`; even a retained URL in `UNKNOWN` must never reach the client. Poster comes from an already trusted product photo. Avoid server-side fetching.
- In `src/components/brand/product-media-stage.tsx` (or its small child), anchor exactly one thumbnail button at bottom-right. Do not overlap the existing bottom-right photo counter, bottom-left Flash Sale badge, desktop navigation or mobile swiping.
- Label: `Xem video`, with Play icon; no `LIVE` label. Keep a clearly visible focus indicator and a usable touch target.
- Modal: native `<video controls playsInline preload="none">`, with source attached **only after an explicit click**. For approved MP4 use appropriate `video/mp4` source type. Close/Escape pauses playback, removes the source, restores focus; size/color/cart state is unchanged.
- Do not add the video to the image carousel or its index/count; no autoplay on page load. On playback error show a simple message and retain photo/checkout functionality.
- If no reliable poster/photo exists, hide the tile rather than decode the MP4 on the VPS.

## 7. Security, performance, and rollout

- Use strict origin/path policy and existing CSP (`media-src`) rules. No wildcard, generic proxy, arbitrary remote fetch, API key in browser, raw payload logs, or sensitive URL logs.
- Verify actual browser-playable MP4 and seeking with a bounded Range GET (206) plus iOS Safari and Android Chrome; HEAD 200 is only preliminary evidence.
- Before user click, network logs must show zero MP4/MOV requests. Validate layout and interactions at 320/390/768/1024/1440 CSS pixels.
- Add opt-in feature flag `LA_PDP_PANCAKE_VIDEO_ENABLED`, default OFF; only turn ON after controlled runtime tests and owner approval. Rollback by disabling flag, not by destructive migration.
- Use the existing full catalog sync schedule; do not assume near-real-time updates. Observe sync success and per-state `READY/NONE/CONFLICT/UNKNOWN/UNSUPPORTED` and reason counts, playback errors and LCP/CLS; never emit raw video URLs or API keys.

## 8. Implementation slices / verification gates

1. **Video parser TDD:** distinguish explicit `videos:null`/`[]` from missing, invalid type/member, overlong/oversized array, malicious host/path, MOV, and valid MP4. A video-only error may not block valid commerce price/stock.
2. **Product policy TDD:** test every-variation coverage (including hidden/locked/out-of-stock), all same MP4, all empty, single-variation URL, partial coverage (`MP4 + null`), multiple distinct URLs, MOV only, missing/malformed/untrusted, and `CONFLICT` overriding another `UNKNOWN`. Results and stored URL actions match `4.
3. **Mirror tests:** initial state `UNKNOWN`; atomic URL/state writes; `READY -> NONE/CONFLICT/UNSUPPORTED` clears; `READY -> UNKNOWN` preserves URL but hides; `UNKNOWN -> READY` restores; complete snapshot only; no partial update on failed pagination; repeated sync idempotent; shop isolation, price/stock unaffected.
4. **Read/UI tests:** only `READY` with valid MP4 and flag ON renders tile; `UNKNOWN` retaining a URL renders nothing and never exposes source; accessible modal, focus/Escape, explicit media request, preserved variant/cart, unchanged photo counts, error fallback, flag OFF.
5. **CI/browser:** `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm test:db`, `pnpm build`; Playwright viewport/network/accessibility checks and human PR review.
6. **Release gate:** reproduce sanitized video response evidence; check some partially covered product if available; verify MP4 playback and 206 seeking on mobile browsers; verify controlled add/delete/replace transition and actual production sync interval. Do not claim instantaneous deletion from read-only observations.

## 9. Acceptance criteria

- AC1: Parse only `variation.videos`. `null`/`[]`, missing and malformed remain distinct; invalid optional video never prevents price/stock sync.
- AC2: `READY` requires **all variations** to provide the **same one trusted MP4**; one subset only, mismatching color URLs or multiple distinct source URLs => `CONFLICT` and no tile. MOV-only => `UNSUPPORTED`.
- AC3: Complete, conclusive `NONE/CONFLICT/UNSUPPORTED` clears old URLs; `UNKNOWN` preserves old URL but **suppresses every client-facing tile/source**; failed/incomplete pagination never commits partial mirror changes.
- AC4: URL/state update is atomic and shop-isolated, migration defaults to `UNKNOWN`, and repeated syncs are idempotent without altering editorial content.
- AC5: One bottom-right **overlay tile**, not carousel item; no video network before click; photo counters, Flash Sale and variant/cart interactions remain unchanged.
- AC6: Modal plays/closes accessibly, pauses, restores focus and handles media errors.
- AC7: Repo test/build/security/rollout gates and `05_SHARED_REFERENCES.md` Definition of Done pass before human implementation-PR approval.

## 10. Remaining uncertainties (must be marked in PR)

- The 6,851-variation scan was **reported by another agent**, not independently reproduced here. Keep raw evidence private; retain sanitized field/type/count results.
- `videos:null` was observed, but actual add/remove latency is **not confirmed** without a controlled mutation. The `NONE` clear-on-complete-snapshot rule is a proposed deterministic mirror policy, not evidence of instant Pancake propagation.
- Browser codec/206 seeking, playback and the production sync interval are unverified.
- Full all-variation coverage for the reported 130 products sharing a URL **was not independently measured**. Some may be `CONFLICT` if only a subset carries a video. Do not promise 130 visible tiles.
- Variant/color-aware switching and MOV transcoding are out of scope and require separate approval.


This PR updates documentation only. It does not implement, enable, or deploy the feature; no application code, database row, production configuration, or runtime behavior is changed.
