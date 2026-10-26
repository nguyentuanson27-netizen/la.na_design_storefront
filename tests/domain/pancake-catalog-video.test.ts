import assert from "node:assert/strict";
import test from "node:test";
import { countPancakeProductVideos, formatPancakeVideoSyncCounts, parsePancakeVariationVideo, resolvePancakeProductVideo } from "../../src/integrations/pancake/catalog-video.ts";
import { resolvePancakePdpVideo } from "../../src/commerce/pancake-pdp-video.ts";
import { parseTrustedProductVideoUrl } from "../../src/commerce/product-media.ts";

const A = "https://content.pancake.vn/videos/2026/10/26/a.mp4";
const B = A.replace("a.mp4", "b.mp4");
const MOV = A.replace(".mp4", ".mov");
const evidence = (videos: unknown) => parsePancakeVariationVideo({ videos });

test("optional video parser distinguishes empty, missing, malformed and trusted source evidence", () => {
  assert.deepEqual(evidence(null), { kind: "EMPTY" });
  assert.deepEqual(evidence([]), { kind: "EMPTY" });
  assert.deepEqual(parsePancakeVariationVideo({ product: { videos: [A] } }), { kind: "UNKNOWN", reason: "missing" });
  assert.deepEqual(evidence([A, A]), { kind: "URLS", urls: [A] });
  assert.deepEqual(evidence([MOV]), { kind: "URLS", urls: [MOV] });
  assert.equal(parseTrustedProductVideoUrl(MOV), null, "MOV must never become playable");
  for (const raw of [undefined, "", {}, [A, null], [42], Array(9).fill(A), ["x".repeat(4097)], [A + " ".repeat(4096)]]) {
    assert.equal(evidence(raw).kind, "UNKNOWN");
  }
  for (const raw of [A.replace("https:", "http:"), A.replace("content.pancake.vn", "evil.test"), A.replace(".mp4", ".webm"), A.replace("content.pancake.vn", "content.pancake.vn:443"), A.replace("content.pancake.vn", "user@content.pancake.vn"), A.replace("/videos/", "/%2e/videos/"), A.replace("/videos/", "/../videos/"), A.replace("/videos/", "/bad\\videos/"), A.replace("a.mp4", "a\n.mp4")]) {
    assert.equal(evidence([raw]).kind, "UNKNOWN", raw);
  }
});

const cases = [
  [[ [A], [A], [A] ], "READY", A, null],
  [[ [A] ], "READY", A, null],
  [[ null, [], null ], "NONE", null, null],
  [[ [A], null ], "READY", A, null],
  [[ [A], [B] ], "READY", A, "multi_url"],
  [[ [A, B] ], "READY", A, "multi_url"],
  [[ [A], undefined ], "READY", A, null],
  [[ [A], [A, null] ], "READY", A, null],
  [[ [A], null, undefined ], "READY", A, null],
  [[ [A], [B], undefined ], "READY", A, "multi_url"],
  [[ [MOV, A], null ], "READY", A, null],
  [[ null, [MOV] ], "UNSUPPORTED", null, "mov_only"],
  [[ [B], [A, B] ], "READY", A, "multi_url"],
  [[ [MOV], [MOV] ], "UNSUPPORTED", null, "mov_only"],
  [[ [MOV], undefined ], "UNKNOWN", undefined, "malformed"],
  [[ null, null, undefined ], "UNKNOWN", undefined, "malformed"],
] as const;
for (const [videos, state, url, reason] of cases) {
  test(`product policy ${JSON.stringify(videos)} => ${state}`, () => {
    const observations = videos.map(evidence);
    const result = resolvePancakeProductVideo(observations);
    assert.equal(result.state, state);
    assert.equal(result.url, url);
    assert.deepEqual(result.reasons, reason ? [reason] : []);
    assert.deepEqual(resolvePancakeProductVideo([...observations].reverse()), result, "API order cannot decide video");
  });
}
test("no coverage is UNKNOWN and normalized duplicate URLs do not conflict", () => {
  assert.equal(resolvePancakeProductVideo([]).state, "UNKNOWN");
  assert.equal(resolvePancakeProductVideo([evidence([` ${A} `, A]), evidence([A])]).state, "READY");
});

test("PDP gate requires opt-in, READY, trusted MP4 and trusted photo", () => {
  const input = { state: "READY", url: A, poster: A.replace(".mp4", ".jpg") };
  assert.deepEqual(resolvePancakePdpVideo({ ...input, enabled: "true" }), { src: A, poster: input.poster });
  for (const enabled of [undefined, "false", "1", "TRUE", ""]) assert.equal(resolvePancakePdpVideo({ ...input, enabled }), null);
  for (const state of ["UNKNOWN", "NONE", "CONFLICT", "UNSUPPORTED"]) assert.equal(resolvePancakePdpVideo({ ...input, enabled: "true", state }), null);
  for (const url of [null, MOV, "https://evil.test/a.mp4"]) assert.equal(resolvePancakePdpVideo({ ...input, enabled: "true", url }), null);
  for (const poster of [null, A, "https://evil.test/a.jpg"]) assert.equal(resolvePancakePdpVideo({ ...input, enabled: "true", poster }), null);
});


test("sync diagnostics contain aggregate state/reason counts without source URLs", () => {
  const videos = cases.map(([raw]) => resolvePancakeProductVideo(raw.map(evidence)));
  const counts = countPancakeProductVideos(videos);
  assert.deepEqual(counts.states, { READY: 11, NONE: 1, CONFLICT: 0, UNKNOWN: 2, UNSUPPORTED: 2 });
  assert.deepEqual(counts.reasons, { partial_coverage: 0, multi_url: 4, mov_only: 2, missing: 0, malformed: 2, untrusted: 0 });
  const log = formatPancakeVideoSyncCounts(counts);
  assert.ok(log.includes('"multi_url":4'));
  assert.ok(!log.includes("https:") && !log.includes("pancake.vn"));
  assert.equal(formatPancakeVideoSyncCounts(undefined), "");
  assert.deepEqual(parsePancakeVariationVideo(Object.create({ videos: [A] })), { kind: "UNKNOWN", reason: "missing" });
});
