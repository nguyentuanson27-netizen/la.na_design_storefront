# Amendment: Google Flow provider for Storefront Virtual Try-on

Status: **Approved by owner on 2026-10-05 for implementation behind the existing kill switch.**

This amendment changes only the provider/runtime parts of
[`storefront-virtual-try-on.md`](./storefront-virtual-try-on.md). All existing storefront rules
remain authoritative unless this document explicitly replaces them: product eligibility, exact first
trusted product image, one shopper photo, likeness acknowledgement, age gates, one result, rate
limits, same-origin request handling, no app-side durable image storage, accessibility, and
commerce isolation.

## Provider decision

The storefront may use either provider, selected only by server configuration:

- `flow` — the primary provider: a private Google Flow worker that drives a signed-in, headed Chrome session.
- `vertex` — Vertex AI Nano Banana Pro (`gemini-3-pro-image`, location `global`), retained as the manual
  operator rollback path. The dedicated `virtual-try-on-001` VTO model has been removed.

There is **no automatic Flow -> Vertex fallback**. One shopper action must never silently spend both
provider allowances.

### Vertex overflow (amendment 2026-10-11, owner decision)

Vertex may serve a request *instead of* Flow, never after it. The provider is chosen before anything
is sent and never revisited, so one shopper action still reaches exactly one provider:

- **Flow** when its single slot is free and it is not marked down;
- otherwise **Vertex**, if overflow is configured and its gate allows it (a daily cap and its own
  in-flight limit);
- otherwise `BUSY`, as before.

A Flow failure is **never** retried on Vertex: a Flow timeout may still finish and spend, and a
content/safety refusal must stay final. What Flow does with the requests it gets sets its health:
an auth failure marks it down for 30 min, a quota `BUSY` from the worker (its final model refused for
quota: HTTP 429) for 10 min, and three generic failures or timeouts in a row for 15 min. A `BUSY` that
only means the worker is momentarily held (its lock, a held Chrome profile, an operator's `/v1/cool`
pause: HTTP 409) does not count. While it is down, requests go
to Vertex; the first one afterwards tries Flow again.

Configuration (`LA_TRY_ON_OVERFLOW_PROVIDER=vertex`, the Vertex project and credential, and
`LA_TRY_ON_VERTEX_DAILY_CAP`) is server-only and fail-soft: anything missing or invalid leaves Flow
alone, exactly as without overflow. The cap counts Vertex generations per calendar day in Vietnam
time, in process memory (a restart starts it again). Routing to Vertex only reserves one of the day's
generations; it is spent at the Vertex call, and handed back if the request ends before that (e.g. the
garment image could not be fetched). Reservations count against the cap, so it cannot be overshot.

Because the shopper consents before anyone knows which provider will serve them, the privacy
disclosure with overflow on names both processors, says Vertex is used when Flow is busy or down,
and says each generation uses only one of them. Vertex keeps its own explicit safety settings and
`personGeneration` contract; results may differ in look between the two providers.

Operator gates before turning overflow on in production: the Vertex project/billing and a
least-privilege service account, the credential mounted read-only (see `deploy/vps/env.example`),
an agreed daily cap, a live Vertex generation and the consented minor test on Vertex.

For the Flow provider, the model policy is explicit:

1. attempt **Nano Banana Pro** (`nano-pro`) first;
2. only when that attempt is rejected for **any quota, rate-limit (HTTP 429, RESOURCE_EXHAUSTED,
   including per-minute or unspecified limits) or Flow credit refusal**, attempt **Nano Banana 2.1**
   once (gflow `nano2`, which the worker's launcher pins to
   Flow's "Nano Banana 2.1" menu entry);
3. do not fall back for authentication failures, safety/content refusals, WAF/reCAPTCHA unusual
   activity, generic network/provider failures, selector drift or timeout;
4. never fall back to Nano Banana 2, Nano Banana 2 Lite or a video model.

The fallback is deliberate product behavior, not a hidden "try another model" retry.

## Flow request contract

The existing server still resolves and validates:

- one shopper JPEG/PNG;
- the exact first trusted garment JPEG/PNG;
- likeness acknowledgement and age state;
- product eligibility and abuse limits.

The private Flow worker receives those two already-approved images over the Compose backend network.
The worker owns the prompt, model choice, browser session, and generation. The browser never receives
the worker token and shoppers never provide a free-form prompt or model.

The fixed Flow prompt must instruct the model to use the shopper image as the person reference and
the product image as the garment reference, preserve identity/apparent age/pose/body proportions and
garment silhouette/color/pattern/details, avoid unrelated accessories or sexualisation, and produce
one realistic fashion try-on image.

The worker requests exactly one image. A returned image is untrusted and must be signature-validated
as JPEG/PNG before it is returned to the shopper.

## Runtime shape

Keep the synchronous storefront contract for this slice:

```text
POST /api/try-on
  -> existing validation / eligibility / limiter
  -> private HTTP to flow-worker
  -> gflow-cli + headed Google Chrome + signed-in Google Flow session
  -> one generated image
```

The worker is a separate Compose service. It is not exposed on the public/edge network. A single
Google profile is serialized to one generation at a time. If the profile is already in use, the
worker fails fast as busy instead of launching a second browser on the same profile.

The worker uses a request-scoped temporary directory for the two input files, generated download,
and gflow's local SQLite operation catalog. `GFLOW_CLI_DB_PATH` is overridden to that temp
directory for every generation, so Flow operation/media IDs, prompt hashes, local paths, hashes and
byte counts recorded by gflow do not land in the persistent Chrome-profile volume. The whole
request directory is deleted after every request.

The persistent `flow_gflow_data` volume holds the signed-in Chrome profile used by gflow.
Non-generation gflow commands use an ephemeral container-local DB path rather than placing the
gflow SQLite catalog in that volume.

That Chrome profile is a browser-managed persistent storage boundary, not merely an auth-token
file. The integration does not currently prove that Chrome/Flow browser storage or cache contains
no shopper/generated media or derived data. Absence of such data from the persistent profile is
therefore **not** part of the implementation guarantee and remains a live retention/cleanup gate.

## Authentication and secrets

The Flow session profile is production secret material. It must:

- live in a dedicated persistent volume outside Git;
- never be copied to logs, CI artifacts, PRs, or browser responses;
- be mounted only into the worker;
- be created by an operator through the real Google sign-in flow;
- fail closed as `AUTH_FAILED` when absent/expired.

The storefront -> worker call is authenticated with a high-entropy server-only bearer token.
The worker port is reachable only on the Compose backend network and is never published publicly.

## Privacy difference from the Vertex contract

La.na Design does not durably persist shopper/generated image bytes through its application-managed
Prisma tables, object storage, analytics, logs, request temp files, or gflow SQLite generation
catalog. Request temp files and the generation catalog are deleted after the call.

The signed-in Chrome profile is intentionally persistent and is managed by Chrome/Playwright. This
code does not control or prove the absence of shopper/generated media or derived data in that
profile's browser storage/cache. Google Flow is also a consumer web application with project/history
semantics. The implementation therefore **must not claim zero retention** across the persistent
Chrome profile or Google's systems. Production enablement is blocked until the owner approves
buyer-facing copy and the operator records live profile inspection plus a retention/cleanup policy.

This replaces the original spec's Vertex-specific Google Cloud retention wording for requests routed
through `flow`.

## Safety difference from the Vertex contract

The Vertex rollback request pins explicit harm-category safety controls and `personGeneration`. The Flow image composer does not
expose the same `personGeneration`, `safetySetting`, or watermark contract through this
integration.

Therefore Flow is **not** treated as safety-equivalent merely because it returns an image. The
existing server-side likeness and age gates remain mandatory, and production enablement requires
controlled live quality/safety review, including the already-required consented minor test.

A Flow content/safety refusal is final for that shopper action. It must not trigger Nano Banana 2.1
or Vertex fallback.

## Acceptance criteria added/replaced by this amendment

- [ ] `LA_TRY_ON_PROVIDER=flow` selects Flow; `vertex` preserves the existing provider.
- [ ] Flow configuration fails closed when worker URL/token are missing or malformed.
- [ ] Storefront sends only validated person/product images to the private worker.
- [ ] Worker selects Nano Banana Pro first.
- [ ] Any Pro quota, rate-limit (incl. per-minute, HTTP 429, unspecified RESOURCE_EXHAUSTED) or credit
      refusal causes exactly one Nano Banana 2.1 attempt.
- [ ] A Nano Banana 2.1 submit is accepted only with its live-captured wire model key configured.
- [ ] WAF/reCAPTCHA, auth, safety, timeout, selector drift and generic failures do **not** trigger
      model fallback.
- [ ] There is never an automatic Flow -> Vertex fallback after a Flow request; with overflow on,
      Vertex serves only requests routed to it *before* sending (Flow busy or marked down), within
      its daily cap, and each request reaches exactly one provider.
- [ ] With overflow on, the disclosure names Flow and Vertex and when each is used.
- [ ] Worker accepts at most one in-flight generation per Google profile.
- [ ] Worker request/response bodies, Google cookies/profile data and bearer token are never logged.
- [ ] Worker local input/output files and gflow SQLite generation catalog are request-scoped and
      removed after the call.
- [ ] The persistent Chrome profile is treated as an unresolved browser-storage retention boundary;
      no claim is made that it contains only auth/session material.
- [ ] Provider output is bounded and JPEG/PNG signature-validated by the storefront.
- [ ] Vertex remains available as a manual rollback provider.
- [ ] Existing try-on domain/endpoint/browser regressions stay green.
- [ ] Worker Python runtime dependencies are installed from the checked-in gflow v0.82.1 lock with
      hashes; the Python base image is digest-pinned and Chrome is version-pinned with an explicit
      review/live-smoke update policy.
- [ ] Lint, typecheck, tests and build pass.
- [ ] Live Flow generation, Pro-quota -> Nano2 fallback, persistent-profile inspection/cleanup,
      Google Flow privacy behavior and minor safety are recorded as human/operator gates before
      production enablement.

## Explicitly not in this slice

- background job/queue infrastructure;
- multi-account rotation;
- Nano Banana 2 Lite fallback;
- client-selectable model or prompt;
- automatic provider fallback;
- weakening existing age/likeness/product-media boundaries.
