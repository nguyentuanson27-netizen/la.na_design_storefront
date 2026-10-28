# Pancake product video on the PDP

Implements [spec v0.3](../specs/pancake-product-video-overlay-v0.3.md) from PR #216
with the owner's [v0.4 selection revision](../specs/pancake-product-video-overlay-v0.4.md)
in PR #217: one video from the current product's own variations, independent of
child/component videos and sibling coverage.
The runtime flag `LA_PDP_PANCAKE_VIDEO_ENABLED` defaults OFF. This implementation
and its fixture tests do not authorize production activation.

## Sync and persistence

The existing full catalog traversal parses only each variation's own `videos`
field. Optional video failures cannot fail otherwise valid price/stock parsing.
The parser bounds each array to eight entries and each input URL to 4,096
characters, normalizes/deduplicates URLs, and uses the reviewed HTTPS Pancake
origin/path checks. MOV is recognized as source evidence only: the playable media
allowlist remains MP4. No media bytes are downloaded by sync.

`validateCatalogSnapshot` groups observations by the exact canonical product ID,
including hidden, locked and out-of-stock own variations, before storefront
filtering. It never follows component edges for video. For a composite parent,
only graph-identified parent variations supply video; a component SKU sharing the
same product ID is excluded too. Parent-role ownership survives inventory
quarantine and parser-prequarantined snapshots, including missing parents whose
product ownership is retained in quarantine metadata. Any trusted own MP4 makes
the product READY; empty/unknown sibling SKUs and component videos do not veto it.
Multiple candidates resolve to the smallest normalized MP4 URL by code-unit
comparison, independent of input order. URL and state are written in the existing
snapshot transaction on create, update, legacy slug healing and reactivation:

| State | URL write | Display |
| --- | --- | --- |
| READY | Set one deterministic MP4 from this product's own variations | Eligible with flag ON and trusted photo |
| UNKNOWN | Omit URL update, preserving the old value | Hidden; retained URL never enters client props |
| NONE | Clear | Hidden |
| CONFLICT (legacy) | Not emitted by v0.4; next full sync reclassifies | Hidden |
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

The video is one 9:16 frame at every width; where it sits depends on the layout. Below `lg` (phone)
it is a frame on the photograph's right edge, about a quarter of the photo's height above its bottom,
outside the swipe track. From `lg` up it is a floating mini-player (168 px wide, pinned 1.5 rem from
the viewport's right and 6.5 rem from its bottom, in the column above the chat button, z-index 44,
under the header and dialogs) with a close button (`Đóng video nhỏ`).

The frame is a muted, looping, `playsInline` preview that starts by itself (supersedes v0.3's "no
page-load autoplay"; the owner asked for it). It is built to cost the photographs nothing:

- The poster is an optimized photograph (`sizes="120px"`) that paints with the page; the preview
  fades in over it only once it is really `playing`, so a slow start shows the photo, not black.
- The `<video>` is mounted only after the window `load` event, so it never competes with the hero
  image, and `react-dom`'s `preconnect` warms the video origin during SSR.
- It plays only while at least 25% on screen and pauses while the dialog is open.
- It is not mounted at all under `prefers-reduced-motion`, Data Saver or a 2G link
  (`use-inline-video-allowed.ts`); the frame stays a poster and the dialog is one tap away.
- A load error, or metadata with no picture (HEVC discarded by the browser), removes the preview and
  leaves the poster. It sends no telemetry, so attempt/failure counters still mean explicit openings.

Desktop mini-player rules. It floats only while the photographs are in view (the gallery's bottom edge
is in the top three quarters of the viewport); scrolling on towards the purchase panel docks it back
onto the photograph, where it would otherwise sit over the price and the buy buttons, and scrolling
back up floats it again. Closing it with the button dismisses it for that page view: the original
small 96x76 poster tile (no preview) stays on the photograph's right edge, and so does the tile when
the preview is not allowed. Before the page has loaded the tile is that same small poster tile.
Dismissal is not remembered across pages.

Tapping the frame opens a native modal dialog with a 9:16 player (`max-w-md`, the same on every width).
Only that tap mounts `<video controls playsInline preload="none">` with an MP4 source and calls
`play()` explicitly (not the `autoplay` attribute, so `play` fires at once and the 15 s startup
deadline runs even if no byte arrives). It carries on from the second the preview had reached (the
default playback start position is set before any data) rather than from 0, and closing hands the
second it left off at back to the preview. Closing or pressing Escape pauses the player, removes its
source, unloads it and restores focus. Unmounting also releases playback. Media errors show a short
message and leave selection, photography and purchasing available. No CSP expansion, remote
fetch/proxy, transcoding or new polling job is needed.

### Keeping the first frame fast

What the page controls is done above. What it cannot is the file itself, so the source video matters
most: H.264 (not HEVC) in an MP4 with `-movflags +faststart` (moov atom first, so playback starts
without reading the tail), about 540x960 at roughly 600-900 kbps, ideally a 5-10 s loop since the
preview repeats, served with `Accept-Ranges` and long-lived `Cache-Control` from the CDN. The dialog
then re-uses the preview's cached bytes.

## Regression coverage

| Contract | Evidence |
| --- | --- |
| Optional parsing, bounds, hostile URLs, MOV and nested-field rejection | `tests/domain/pancake-catalog-video.test.ts`, `pancake-catalog-contract.test.ts` |
| Partial own-SKU coverage allowed, deterministic MP4 selection, component isolation and API order independence | `tests/domain/pancake-catalog-video.test.ts` |
| Defaults, transitions, atomic rollback, idempotence, shop ownership, hidden/locked/zero-stock variants, reactivation and unchanged commerce/editorial facts | `tests/database/pancake-product-video.test.ts` |
| Failed/incomplete pagination leaves READY unchanged | `tests/database/pancake-product-video.test.ts`, `tests/integrations/catalog-sync.test.ts` |
| Flag/state/MP4/photo gate; UNKNOWN retention suppressed | Domain, database and rendered-browser tests |
| One 9:16 frame inside the primary photo (two-photo and single-photo desktop layouts); counters/navigation/Flash Sale; 320/390/768/1024/1440 px; muted autoplaying preview, desktop floating mini-player (docks on scroll, closes to the small tile), resume-from-preview, poster fallback, reduced-motion opt-out | `tests/a11y-runtime/pdp-pancake-video.spec.ts` |
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
  a partially covered product to exercise v0.4 if one exists. The original reported scan was not
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
playback. A 15-second startup deadline begins on native `play` intent. `playing`
cancels
it; `waiting`/`stalled` during an active attempt without future buffered data arm
the same bounded wait without resetting an existing deadline. A network stall
while playback still has future data is not a playback failure. Pause/ended, close/Escape, native failure and
unmount cancel it. Expiry emits one `timeout` failure, shows the fallback and
pauses/unloads the source. Later timeout/native callbacks cannot double-count.
Reopening creates a fresh attempt. No event is sent just for viewing the PDP or
opening a player that has not tried to play.

`POST /api/product-video/events` is a real first-party collector in the existing
JSON stdout stream (ADR 0002), gated by the same default-OFF feature flag. It
accepts only `{kind:"attempt"}` or `{kind:"failure",reason}` with reason network,
decode, unsupported, timeout or unknown. It rejects extra fields, requires the
configured
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

From a fresh VPS shell in the deployed repository (Bash, jq and Docker Compose
are required; the deployed release-tagged ops image supplies Node):

```sh
bash deploy/vps/pdp-video-telemetry.sh 1h
```

The wrapper resolves the repository root, reads only `DEPLOY_TARGET` from
`deploy/vps/.env.production`, sources `project-identity.sh`, and invokes Compose
with both `--env-file deploy/vps/.env.production` and `-f deploy/vps/compose.yml`.
Thus project/domain/database identity comes from `project.config.json`, while
required image, release, database and edge settings come from the deployment env
file exactly as in `deploy.sh`. It never sources/evaluates the secret env file or
prints its contents. Production and temporary deploy targets are both supported.

The optional argument is a positive duration in s/m/h; the default is `1h`.
Raw logs are spooled to a mode-0600 temporary file, summarized only after Compose
succeeds, and deleted on exit. The summary runs in the deployed ops image with
`--rm -T --no-deps --pull=never`: no host Node install, image pull/build or dependent
service startup is needed. A Compose/configuration failure exits nonzero and
produces no misleading NO_DATA JSON report. This command reads logs and starts
only a transient summary container. It does not build, restart, deploy application
or database services, or change the feature flag.

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
