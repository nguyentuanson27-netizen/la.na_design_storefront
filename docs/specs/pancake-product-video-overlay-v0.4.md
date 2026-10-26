# Spec v0.4 — one video from the current product's own variations

Date: 2026-10-26 (Asia/Saigon).
Authority: owner clarification during PR #217 review: use the variation video of
the parent product, like the supplied source link; no requirement for child SKUs
to carry the same video.

This revision supersedes v0.3 §4 and AC2 (uniform all-variation coverage), and the
corresponding persistence/verification clauses wherever they depend on that old
selection policy. All other URL-trust, atomic snapshot, UI, telemetry and default
OFF/release requirements remain applicable.

## Source and selection

“Parent product video” means `variation.videos` on variations whose canonical
`product_id` is the exact product displayed by the PDP. It does not mean a new
`product.videos` API field. No such product-level field has been established.

Use only this product's own variation video observations in a complete validated
catalog snapshot. Do not follow composite edges to source video from component
products/SKUs. A component's video cannot supply, veto or replace its parent's
video; it remains scoped to the component's own product. If the composite graph
identifies parent variations, only those variations supply that parent's video,
even if a component SKU shares its product ID. Parent-role ownership is retained
when a composite is quarantined (including parser-prequarantined IDs); inventory
quarantine does not authorize falling back to a component video. Quarantine
metadata retains the known parent product identity even when that parent is
absent from the flat catalog. No observed parent variation then means UNKNOWN,
never a child-video fallback.

Only one trusted MP4 is needed. Other own SKUs may be empty, missing, malformed,
MOV-only or carry different videos without vetoing that valid MP4. Hidden,
locked and out-of-stock variations remain source observations; stock and purchase
selection do not choose the video. Parser bounds remain eight URLs per variation
and 4,096 characters per URL. A malformed array is still UNKNOWN as a whole.

If several trusted MP4 candidates exist, choose the smallest normalized URL by
JavaScript code-unit comparison. This deterministic tie-break is independent of
API/array order, requires no owner guessing by color, and adds no manual picker.
Deduplication/selection is done in one pass; no child-product scan or new request
is added.

| Own product observations | State | URL action |
| --- | --- | --- |
| A valid MP4 anywhere, with empty/missing/invalid sibling observations | READY | Set that MP4 |
| Multiple valid MP4 URLs | READY | Set deterministic one; `multi_url` diagnostic |
| MP4 and MOV | READY | Select MP4 only |
| No valid MP4 and any UNKNOWN observation | UNKNOWN | Preserve old URL, hide all client video |
| No valid MP4 or UNKNOWN, but trusted MOV observed | UNSUPPORTED | Clear |
| All observations explicitly empty | NONE | Clear |
| No observations/incomplete coverage | UNKNOWN / no snapshot write | No inferred deletion |

`CONFLICT` is retained as a legacy enum/read-gate value for compatibility. The
v0.4 selector does not emit it for partial coverage or multiple video URLs.
Existing CONFLICT rows remain hidden until the next successful full sync resolves
them. `partial_coverage` stays zero in the retained diagnostic shape; `multi_url`
now means a deterministic selection was made, not a display blocker.

## Persistence, UI and verification

State and URL still share one source-mirror write and the full catalog transaction.
A failed/incomplete traversal never commits partial updates. Repeated snapshots,
including reordered input, must select the same URL. URL/state remain shop scoped.
Website-owned editorial content is unaffected.

The server still requires flag ON, READY, a revalidated MP4 URL and trusted photo.
The single overlay/modal, unloaded-by-default source, navigation/counters, safe
playback collector and unsupported-track fallback remain as implemented.

Tests must prove READY for partial/missing own-SKU coverage; deterministic choice
across multiple URLs and reordering; MP4 preference over MOV; conclusive clearing
when no MP4 remains; UNKNOWN retention; and a real composite parent/component
snapshot where child video never becomes a parent candidate or fallback.

This source-policy change does not enable or deploy the feature. Real device/CDN
playback, source mutations, sync latency, production performance and operational
telemetry validation remain activation gates, including the supplied QuickTime /
HEVC sample finding.
