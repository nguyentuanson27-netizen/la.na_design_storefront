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

- Review the [owner-provided CDN sample evidence](../audits/pancake-video-playback-evidence-2026-10-26.md): actual first/tail Range requests passed, but the MP4-suffixed file is QuickTime/HEVC and Linux Chromium discarded its video track. Real-device gates remain open.
- Reproduce sanitized live variation video field/type/coverage evidence; identify
  a partially covered product if one exists. The original reported scan was not
  independently repeated by this implementation.
- Verify a bounded real CDN Range request, 206 seeking and actual MP4 playback on
  iOS Safari and Android Chrome. Synthetic Chromium evidence does not close this.
- Verify controlled source add/delete/replace transitions and observe convergence
  after a complete sync; confirm the actual production sync interval and success.
- Check real-product layout, LCP/CLS and playback failures during controlled QA,
  then obtain the owner's rollout decision. Human PR review is still required.

### Playback error observability — implemented; production evidence still required

The native player's `onPlay` sends one anonymous attempt per explicit opening.
Pause/resume and seeking do not add attempts. A failure sends one failure across
both source/player callbacks; an error before `onPlay` also records an attempt.
Intentional aborts, close/Escape and late callbacks after closure are ignored.
An audio-only result (metadata with zero video dimensions, as can happen with an
unsupported HEVC track inside an otherwise playable container) is counted as
unsupported and unloaded. A progressing audio clock alone never proves video
playback. Reopening creates a fresh attempt. No event is sent just for viewing the PDP or
opening a player that has not tried to play.

`POST /api/product-video/events` is a real first-party collector in the existing
JSON stdout stream (ADR 0002), gated by the same default-OFF feature flag. It
accepts only `{kind:"attempt"}` or `{kind:"failure",reason}` with reason network,
decode, unsupported or unknown. It rejects extra fields, requires the configured
storefront Origin and JSON content type, caps the actual body at 128 bytes and
bounds reads to three seconds. No Host/forwarded header chooses the origin.

The browser sends no credentials/cookies or referrer. Payloads and collected log
records contain no source/poster URL, product ID/slug, account/session identifier,
raw error or remote response. Telemetry transport/storage errors are swallowed,
with no retry, so collection cannot block playback or checkout. Client callbacks
are deduplicated per opening; this is not an exactly-once or authenticated usage
ledger. Public client signals may be blocked, lost or forged.

Each accepted event emits a fixed JSON delta:

```json
{"name":"pdp_video.playback","attempts":1,"failures":0}
{"name":"pdp_video.playback","attempts":0,"failures":1,"reason":"decode"}
```

A singleton process budget admits at most 600 requests per minute, including
malformed requests that reach the body reader. The first excess request logs one
`{"name":"pdp_video.telemetry_suppressed"}` marker for that window. Budgets reset
on process restart and apply per replica; there is no per-person key or DB row.
The operator must include all app replicas and retain the stdout stream across
container replacement using the existing log-retention policy.

From the deployed repository with its normal Compose environment selected:

```sh
docker compose -f deploy/vps/compose.yml logs --no-color --no-log-prefix --since 1h app \
  | node --experimental-strip-types scripts/pdp-video-playback-summary.ts
```

The summary reports `attempts`, `failures`, per-reason counts, `failureRate`
(fraction), `suppressedWindows` and status. `NO_DATA` has a null rate, never a
healthy zero. `INCOMPLETE` indicates suppression or more failures than attempts;
do not treat that window as proof of successful playback. `OBSERVED` means only
that valid unsuppressed signals were received, not that every browser reported.
The CLI streams records and outputs aggregate counters only. It ignores unrelated
or malformed lines. Docker log rotation/retention and the selected `--since`
window determine how much evidence is available; counters are not stored in DB.

Production-build Playwright exercises the actual route and captured server logs:
successful play/pause/resume, failed load with duplicate callbacks, close/reopen,
flag OFF, privacy headers, collector outages, schema/origin/body rejection. The
forced error and MP4 are synthetic; this closes the missing-collector code gap,
not real-device/CDN verification.

Before activation, the VPS operator (role, not an assigned person) must capture
real iOS Safari/Android Chrome attempt/failure counters and failure recovery,
confirm retention/access and the aggregation command on the production log
stream, and agree the rollout window/threshold with the owner. Proposed controlled
QA stop rule: disable the flag on any reproducible playback/checkout regression,
on an incomplete telemetry window, or a measured failure rate over 5% once at
least 20 attempts are observed. This proposed rule and operator assignment still
require the owner's rollout decision. The flag remains OFF.

`release:check` in this workspace is blocked by missing `PANCAKE_API_KEY`; it is
not evidence of production readiness. `05_SHARED_REFERENCES.md`, named by AC7,
is absent from this repository snapshot, so its additional Definition of Done
could not be evaluated. The available root `AGENTS.md` and Next.js client/server
boundary guidance were followed.

Rollback: set `LA_PDP_PANCAKE_VIDEO_ENABLED=false` and restart/redeploy the app
using the normal configuration flow. Keep the additive mirror columns and sync
states; no destructive migration is needed.
