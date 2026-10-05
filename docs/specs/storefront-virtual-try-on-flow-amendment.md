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

- `vertex` — the existing `virtual-try-on-001` integration, retained as an operator rollback path.
- `flow` — a private Google Flow worker that drives a signed-in, headed Chrome session.

There is **no automatic Flow -> Vertex fallback**. One shopper action must never silently spend both
provider allowances.

For the Flow provider, the model policy is explicit:

1. attempt **Nano Banana Pro** (`nano-pro`) first;
2. only when that attempt is rejected because Nano Banana Pro's **daily image quota is exhausted**,
   attempt **Nano Banana 2** (`nano2`) once;
3. do not fall back for authentication failures, safety/content refusals, WAF/reCAPTCHA unusual
   activity, generic network/provider failures, selector drift, timeout, or per-minute throttling;
4. never fall back to Nano Banana 2 Lite or a video model.

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

The worker uses a request-scoped temporary directory for the two input files and generated download;
that directory is deleted after every request.

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

La.na Design still does not durably persist shopper or generated image bytes in Prisma, app
filesystem, object storage, analytics, or logs.

However Google Flow is a consumer web application with project/history semantics. Even though the
worker deletes its local temporary files, the implementation **must not claim** that uploaded or
generated assets are immediately removed from Google's systems. Production enablement is blocked
until the owner approves buyer-facing copy that accurately describes Google Flow processing/history
and the operator verifies what cleanup the live Flow surface actually provides.

This replaces the original spec's Vertex-specific Google Cloud retention wording for requests routed
through `flow`.

## Safety difference from the Vertex contract

The existing Vertex request pins dedicated VTO safety controls. The Flow image composer does not
expose the same `personGeneration`, `safetySetting`, or watermark contract through this
integration.

Therefore Flow is **not** treated as safety-equivalent merely because it returns an image. The
existing server-side likeness and age gates remain mandatory, and production enablement requires
controlled live quality/safety review, including the already-required consented minor test.

A Flow content/safety refusal is final for that shopper action. It must not trigger Nano Banana 2 or
Vertex fallback.

## Acceptance criteria added/replaced by this amendment

- [ ] `LA_TRY_ON_PROVIDER=flow` selects Flow; `vertex` preserves the existing provider.
- [ ] Flow configuration fails closed when worker URL/token are missing or malformed.
- [ ] Storefront sends only validated person/product images to the private worker.
- [ ] Worker selects Nano Banana Pro first.
- [ ] A documented daily-quota exhaustion on Pro causes exactly one Nano Banana 2 attempt.
- [ ] Per-minute throttling, WAF/reCAPTCHA, auth, safety, timeout, selector drift and generic failures
      do **not** trigger model fallback.
- [ ] There is never an automatic Flow -> Vertex fallback.
- [ ] Worker accepts at most one in-flight generation per Google profile.
- [ ] Worker request/response bodies, Google cookies/profile data and bearer token are never logged.
- [ ] Worker local input/output files are request-scoped and removed after the call.
- [ ] Provider output is bounded and JPEG/PNG signature-validated by the storefront.
- [ ] Vertex remains available as a manual rollback provider.
- [ ] Existing try-on domain/endpoint/browser regressions stay green.
- [ ] Lint, typecheck, tests and build pass.
- [ ] Live Flow generation, Pro-quota -> Nano2 fallback, privacy/cleanup behavior and minor safety are
      recorded as human/operator gates before production enablement.

## Explicitly not in this slice

- background job/queue infrastructure;
- multi-account rotation;
- Nano Banana 2 Lite fallback;
- client-selectable model or prompt;
- automatic provider fallback;
- weakening existing age/likeness/product-media boundaries.
