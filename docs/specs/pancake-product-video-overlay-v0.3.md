# Spec v0.3 - Pancake variation video -> La.Na PDP overlay

Status: **Ready for implementation planning, subject to owner approval. Not ready for production release.**
Date: 2026-10-26 (Asia/Bangkok)
Repo: `nguyentuanson27-netizen/la.na_design_storefront`
Source baseline: `main@12f140a590d450793229a4e25f9602a4ab1f2dd7` (read on 2026-10-26). Supersedes v0.2 regarding the location and type of Pancake video data.

## 1. Objective and strict scope

Display **at most one "Xem video" preview tile** at the bottom-right of the main product photo on `/shop/[slug]`, in the position inspired by the provided Shopee "Xem Live" screenshot. Clicking opens a modal with a native HTML video player. Video is pre-recorded, not a livestream. Do not move video into the photo gallery, change photo counters, alter `galleryIndexByVariantId`, add admin uploads/manual links, proxy media through Next.js, change price/inventory/order logic, or add another API polling job.

Source of truth: Pancake POS. Persist only a trusted video URL in the website's source mirror; never copy video bytes to the database or VPS. No video means no tile; all other product behavior remains unchanged.

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

Under `src/integrations/pancake/catalog-contract.ts`, map `variation.videos` only:

```ts
// illustrative internal shape (adjust to the existing type names)
type ParsedVariationVideo = readonly string[] | null;
```

Parse `null` and a bounded array of strings explicitly. Validate array cardinality and each URL length (4,096 max to match the media trust boundary). Unknown types and malformed elements must fail closed for **video only**; they must not prevent price, stock, and catalog synchronization. Do not pass raw external `videos` directly to client components.

Do not trust `.startsWith("https://content.pancake.vn/")` as the only URL check. Reuse `parseTrustedProductVideoUrl()` and keep the existing HTTPS/host/path/extension/traversal checks. The reported MP4 path should need no broadening of the allowlist. Reject `.mov` in v1: the MOV container is not interchangeable with MP4, and using `type="video/mp4"` for a MOV URL does not transcode it or guarantee playback. Ask operators to upload a browser-compatible MP4 source to Pancake. No auto-transcoding is in scope.

## 4. Choosing one video per product (MVP policy)

The requirement is **one video tile per PDP**, not one tile per variation or one video per gallery slide.

1. Work from one complete, successfully parsed catalog snapshot for the relevant shop. Group variations by canonical `product_id`.
2. Collect a bounded set of distinct nonblank source video URLs from all eligible variations, including unsupported `.mov` URLs when identifying conflicting source choices. Deduplicate identical URLs before evaluation.
3. No candidate => `null` (no tile).
4. Exactly one distinct URL => accept it only when `parseTrustedProductVideoUrl()` approves an MP4 and it is not evidently specific to a different color than the product currently shown. Unknown product-wide association should be conservatively hidden and recorded, not guessed.
5. More than one distinct URL => **conflict: no tile for that product in MVP**. Do not use the first URL in API order, because 7 reported products distinguish colors and an arbitrary video could be misleading. Log only a safe conflict count/reason.
6. A single source URL present on only some color variants is ambiguous. Record its coverage and verify representative products before treating it as product-wide; do not claim the agent's 130/137 count guarantees 130 visible tiles.

A future, separately approved iteration may store per-variation candidates and switch the same single tile by selected color; that is deliberately out of MVP scope.

## 5. Persistence and sync

Proposed nullable source-owned field: `ProductMirror.pancakeVideoUrl String?`, via an **additive Prisma migration**. Do not store Pancake-owned data in website-owned `ProductContent`. Update create, update and reactivation paths in `src/commerce/catalog-mirror-repository.ts` while preserving shop isolation.

Sync is idempotent. A complete successful snapshot may set, replace, or clear the selected URL; do not clear from incomplete/failed paginated fetches. Treat `videos:null` as an observed no-video state. Missing key, malformed source, and unknown semantics of delete transitions should be visible in safe metrics and explicitly tested. Preserve existing commerce behavior even if an optional video fails validation. Hidden/inactive/unpublished products must not surface a video through the PDP route.

## 6. Read model and UI

- Server route returns only a validated optional `{src, poster}` media object; poster comes from an already trusted product photo. Avoid server-side media URL fetching.
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
- Use existing full catalog sync schedule; do not assume near-real-time video updates. Observe sync success, video-present/invalid/conflict counts, playback errors and LCP/CLS; never emit raw video URLs or API keys.

## 8. Implementation slices / verification gates

1. **Contract tests**: `videos:null`, missing field, `[]`, one MP4, repeated URL, 2-3 source URLs, MOV, malformed types, excessive arrays/URLs, malicious hosts and paths, absent/duplicate variation identity. Confirm RED then GREEN.
2. **Mirror tests**: new `ProductMirror` nullable field, one unique trusted URL, conflict omission, clear/update/idempotence, complete snapshot only, shop isolation, no stock/price drift.
3. **Read/UI tests**: optional video in `/shop/[slug]`, correct bottom-right tile, dialog focus and Escape, explicit user-initiated loading, no image-count changes, preserved selected variant/cart, error fallback, feature flag OFF.
4. **Integration/browser tests**: `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm test:db`, `pnpm build`; Playwright screenshot/network/accessibility; CI green and human review.
5. **Live release gate**: compare agent-reported response shape with a sanitized repeatable read-only probe; test live browser playback on at least one MP4 product; verify removal/replacement semantics through a controlled human-operated test where safe; confirm sync interval and content freshness. Do not claim add/delete is instant from the current read-only report.

## 9. Acceptance criteria

- AC1: Parse only `variation.videos: string[] | null`; no guessed product-level `videos` field and no extra Pancake API calls per PDP.
- AC2: At most one trusted MP4 URL per product; conflicting URLs or MOV-only sources never show an incorrect tile.
- AC3: Sync is complete-snapshot-based and idempotent, without affecting stock/price/order or website editorial fields.
- AC4: One **overlay tile**, not a carousel item; no video data request before user click; photo counters and Flash Sale stay usable.
- AC5: Modal plays/closes accessibly, restores focus, pauses media, preserves customer selection, and handles media errors.
- AC6: All repo test/build/security/rollout gates pass, including the Definition of Done in `05_SHARED_REFERENCES.md`; a human approves the final PR.

## 10. Remaining uncertainties (must be marked in PR)

- The live 6,851-variation probe was summarized by another agent and was not independently re-run in this conversation. Raw evidence must stay private; retain sanitized field/type/count evidence for review.
- `videos:null` is observed, but the exact after-add / after-delete transitions and update latency were **not verified**, because no mutation was performed.
- Browser decode, seeking behavior (206), video codec support, and current production sync interval were not verified here.
- A product with different video URLs by color requires either conflict omission (this MVP) or a separately approved variant-aware policy.

This PR updates documentation only. It does not implement, enable, or deploy the feature; no application code, database row, production configuration, or runtime behavior is changed.
