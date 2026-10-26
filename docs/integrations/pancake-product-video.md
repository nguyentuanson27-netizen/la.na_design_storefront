# Pancake product video on the PDP

Implements [spec v0.3](../specs/pancake-product-video-overlay-v0.3.md) from PR #216.
The runtime flag `LA_PDP_PANCAKE_VIDEO_ENABLED` defaults OFF. This implementation
and its fixture tests do not authorize production activation.

## Sync and persistence

The existing full catalog traversal parses only each variation's own `videos`
field. Optional video failures cannot fail otherwise valid price/stock parsing.
The parser bounds each array to eight entries and each input URL to 4,096
characters, normalizes/deduplicates URLs, and uses the reviewed HTTPS Pancake
origin/path checks. MOV is recognized as source evidence only: the playable media
allowlist remains MP4. No media bytes are downloaded by sync.

`validateCatalogSnapshot` aggregates every variation, including hidden, locked and
out-of-stock variations, before any storefront filtering. A known mismatch wins
over unrelated unknown evidence. URL and state are written in the existing
snapshot transaction on create, update, legacy slug healing and reactivation:

| State | URL write | Display |
| --- | --- | --- |
| READY | Set the one MP4 shared by every variation | Eligible with flag ON and trusted photo |
| UNKNOWN | Omit URL update, preserving the old value | Hidden; retained URL never enters client props |
| NONE | Clear | Hidden |
| CONFLICT | Clear | Hidden |
| UNSUPPORTED | Clear | Hidden |

The additive migration starts existing rows at UNKNOWN with a null URL. A failed
or incomplete page traversal never calls the writer. A subsequent transaction
failure rolls back both video and commerce writes. Product identities owned by a
different shop are refused. Website-owned editorial content is untouched.

Both one-shot and scheduled sync output contain only aggregate state/reason
counters. No video URL, raw payload or credential is logged. The existing full
sync schedule is reused; targeted inventory webhook writes do not change video.
The default full reconciliation interval is 3,600 seconds, not a claim about the
production setting or source propagation latency.

## Server boundary and player

The PDP detail repository reads video fields only when the flag is exactly
`true`, scoped to the current product/shop. It returns only a validated
`{src, poster}` for READY and trusted photography. Listings, cards, carousel
items, photo counts and variant-to-photo mappings do not acquire video fields.
The route passes that small projection to the existing media stage.

One bottom-right tile sits above the photo counter and outside desktop navigation
and mobile swipe tracks. On desktop its containing frame matches the first
photograph's portrait cell in the left half, or the centered photo for a one-image
gallery. Clicking opens a native modal dialog. Only that explicit click mounts `<video controls playsInline preload="none">` with an MP4 source.
There is no page-load autoplay or video preload. Closing or pressing Escape
pauses the player, removes its source, unloads it and restores focus. Unmounting
also releases playback. Media errors show a short message and leave selection,
photography and purchasing available. No CSP expansion, remote fetch/proxy,
transcoding or new polling job is needed.

## Regression coverage

| Contract | Evidence |
| --- | --- |
| Optional parsing, bounds, hostile URLs, MOV and nested-field rejection | `tests/domain/pancake-catalog-video.test.ts`, `pancake-catalog-contract.test.ts` |
| Coverage, mismatch precedence, URL normalization and API order independence | `tests/domain/pancake-catalog-video.test.ts` |
| Defaults, transitions, atomic rollback, idempotence, shop ownership, hidden/locked/zero-stock variants, reactivation and unchanged commerce/editorial facts | `tests/database/pancake-product-video.test.ts` |
| Failed/incomplete pagination leaves READY unchanged | `tests/database/pancake-product-video.test.ts`, `tests/integrations/catalog-sync.test.ts` |
| Flag/state/MP4/photo gate; UNKNOWN retention suppressed | Domain, database and rendered-browser tests |
| One tile inside the primary photo (two-photo and single-photo desktop layouts); counters/navigation/Flash Sale; 320/390/768/1024/1440 px; zero video requests before click | `tests/a11y-runtime/pdp-pancake-video.spec.ts` |
| Native playback/seek, close/Escape/focus, Axe, media failure, retained size and usable purchase controls | Same Playwright suite, against a production build |

The 2.2 KB synthetic browser MP4 fixture was generated without audio or external
media. Reproduce with:

```sh
ffmpeg -f lavfi -i color=c=0x3b2219:s=160x160:r=12 -t 4 \
  -c:v libx264 -profile:v baseline -pix_fmt yuv420p -movflags +faststart -an \
  tests/a11y-runtime/fixtures/product-video.mp4
```

It is served by the browser test's bounded Range/206 stub. It proves fixture
playback and player behavior, not Pancake CDN headers, real codecs or mobile
browser compatibility. Browser coverage is included in the existing CI suite.

## Activation gates still open

Before setting the flag to true in a deployed environment:

- Reproduce sanitized live variation video field/type/coverage evidence; identify
  a partially covered product if one exists. The original reported scan was not
  independently repeated by this implementation.
- Verify a bounded real CDN Range request, 206 seeking and actual MP4 playback on
  iOS Safari and Android Chrome. Synthetic Chromium evidence does not close this.
- Verify controlled source add/delete/replace transitions and observe convergence
  after a complete sync; confirm the actual production sync interval and success.
- Check real-product layout, LCP/CLS and playback failures during controlled QA,
  then obtain the owner's rollout decision. Human PR review is still required.

### Playback error observability — OPEN release gate (review P2)

The current error handlers show a shopper-facing fallback only. **No production
playback-error collector/counter is implemented by this PR.** The synthetic
failure test proves the fallback, not operational monitoring. Keep the flag OFF
until the following monitoring work and evidence are reviewed:

- Wire website-owned telemetry for playback attempts and playback failures so an
  operator can compare failure counts with attempts after rollout. Deduplicate
  source/player error callbacks to one failure per explicit opening; reopening
  starts another attempt.
- Allow only fixed event names and reviewed error categories (network, decode,
  unsupported, unknown). Exclude source/poster URLs, product IDs/slugs, user or
  session identifiers, raw errors, request bodies and remote responses. Review the
  receiving collector's retention and access before rollout.
- Force a failure with a real supported mobile browser during controlled QA and
  retain sanitized counter evidence; verify one error is counted, closing still
  works, retries do not double-count, and ordinary playback records no error.
- Identify the operator, dashboard/query and acceptable error-rate threshold for
  the controlled rollout. Disable the existing flag if failures cross that
  threshold; do not log raw media URLs while investigating.

`release:check` in this workspace is blocked by missing `PANCAKE_API_KEY`; it is
not evidence of production readiness. `05_SHARED_REFERENCES.md`, named by AC7,
is absent from this repository snapshot, so its additional Definition of Done
could not be evaluated. The available root `AGENTS.md` and Next.js client/server
boundary guidance were followed.

Rollback: set `LA_PDP_PANCAKE_VIDEO_ENABLED=false` and restart/redeploy the app
using the normal configuration flow. Keep the additive mirror columns and sync
states; no destructive migration is needed.
