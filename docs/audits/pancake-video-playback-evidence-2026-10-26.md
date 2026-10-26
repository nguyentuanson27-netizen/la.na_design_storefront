# Pancake video playback evidence — 2026-10-26

Date: 2026-10-26 (Asia/Saigon). Scope: one MP4-suffixed URL supplied privately by
the owner during PR #217 review. Source URL and downloaded media are deliberately
omitted from the repository/log evidence. This is not a full catalog scan and
makes no claim about production activation.

## Actual CDN read, bounded

A TLS-verified request through the configured session proxy requested exactly the
first 65,536 bytes, then the last 65,536 bytes:

| Observation | Result |
| --- | --- |
| First request | HTTP 206; `Content-Range: bytes 0-65535/45584377` |
| Last request | HTTP 206; `Content-Range: bytes 45518841-45584376/45584377` |
| Bytes received per range | 65,536 |
| Response Content-Type | `video/quicktime` |
| Accept-Ranges response header | Absent; actual 206 responses above prove these two ranges worked |
| Total source size | 45,584,377 bytes (about 43.5 MiB) |

The sample was then downloaded once with a 64 MiB hard cap to private scratch
storage, solely for a controlled decode probe. No media was added to the source
repository or VPS app. Selected `ffprobe` fields, excluding arbitrary tags:

- container major brand: `qt  ` (QuickTime), despite the `.mp4` suffix;
- video: HEVC Main (`hvc1`), 1080 × 1920, `yuv420p`;
- audio: AAC LC (`mp4a`);
- duration: 20.524989 seconds.

The existing URL validator checks trust and path/extension, not codecs or bytes.
These results do not widen that policy or introduce a fetch/transcoding service.

## Controlled browser replay of the exact downloaded bytes

Chromium 151.0.7922.34 on Linux replayed the unmodified file through a local
Range-capable HTTP server using the CDN's same `video/quicktime` MIME and the
player's declared `video/mp4` source type. The server used the downloaded file;
this was **not** a direct browser-to-CDN run.

Both the desktop context and a Pixel 7 emulation context made zero media requests
before an explicit play click. Media Range responses were 206, the playback clock
advanced and seeking reached approximately 10.94 seconds. However, both contexts
reported **videoWidth = videoHeight = 0**, with empty HEVC `canPlayType` support.
They could consume the audio track while discarding video, without a native
MediaError. This is **not successful video playback**.

A separate direct browser-to-CDN probe through the configured proxy reached HTTP
206 and 200 responses with `video/quicktime`, with zero requests before click.
It did not reach metadata/playback within the 15-second observation window
(`readyState = 0`, `currentTime = 0`). The context was then closed and an in-flight
request was aborted. This is incomplete transport/playback evidence, not a passing
CDN playback result; it must not be combined with local replay to claim success.

The app now treats loaded metadata with missing video dimensions as unsupported
video, pauses/unloads it, shows the error fallback, and reports one anonymous
attempt/failure. A generated tiny audio-only fixture verifies that real native
browser path end to end against the collector. Ordinary H.264 playback tests now
also require nonzero video dimensions rather than relying on currentTime alone.

## What remains unverified before activation

- iOS Safari and Android Chrome on actual devices. Android emulation above uses
  the same Linux Chromium decoder and says nothing about Android hardware HEVC
  support. No iPhone/WebKit result is claimed.
- Real CDN playback/seeking from those devices, including codec support and the
  production CSP/transport path. Two successful range reads and local replay do
  not close that gate.
- A controlled Pancake add/delete/replace exercise and measured sync convergence.
  This workspace has no configured Pancake API/shop credentials, and its available
  POS connector supports only read-only sales/stock reports. No source mutation
  was performed and no update latency was invented.
- Actual production catalog-sync configuration and freshness, real-product
  LCP/CLS, and operator validation of the telemetry log stream/retention.

The feature flag remains OFF. The sample's HEVC/QuickTime compatibility finding is
an explicit reason to keep device validation open. No transcoding or color-aware
playback is introduced by this PR.
