# Vertex AI virtual try-on (`virtual-try-on-001`)

Status: **Implemented behind a server kill switch, off by default.** Product contract:
[`docs/specs/storefront-virtual-try-on.md`](../specs/storefront-virtual-try-on.md). This document is the
operational truth for the code: how it is wired, what the Vertex request is, what must be configured,
how to turn it off, and what is still waiting on a human.

## Flow

```text
PDP (server)   resolveProductTryOn()        flag on + category (aoDai|setDo|vayDam) + exact first
                                            trusted image is JPEG/PNG  ->  {productSlug} | null
Browser        BrandTryOnLauncher/useTryOn  multipart POST /api/try-on:
                                            photo, productSlug, likenessAcknowledged, ageState
Route          handleTryOnPost()            same-origin (Origin host == Host), multipart only,
                                            Content-Length and streamed-byte cap, client key
Service        createTryOnService()         flag -> per-client attempt -> read body -> validate
                                            request -> re-resolve product -> eligibility ->
                                            in-flight slot -> trusted product image -> Vertex (once)
Vertex         createVertexTryOnClient()    one :predict, one candidate, response validated
Browser        <img src=blob:> + download   nothing stored; closing the dialog drops and revokes it
```

Files: `src/commerce/try-on-*.ts` (policy, eligibility, request, service, endpoint, rate limit,
runtime wiring), `src/integrations/vertex-try-on/*` (the only Vertex/Google code),
`src/operations/try-on-observability.ts`, `src/app/api/try-on/route.ts`,
`src/components/headless/{use-try-on,try-on-model}.ts`, `src/components/brand/try-on-dialog.tsx`.

A route handler is used instead of a Server Action because a Server Action's body limit is a global
setting; raising it for a 7 MB photo would raise it for every action on the site.

## The Vertex request

`POST https://{location}-aiplatform.googleapis.com/v1/projects/{project}/locations/{location}/publishers/google/models/virtual-try-on-001:predict`

```json
{
  "instances": [
    {
      "personImage":   { "image": { "bytesBase64Encoded": "<shopper photo>" } },
      "productImages": [{ "image": { "bytesBase64Encoded": "<first trusted product image>" } }]
    }
  ],
  "parameters": {
    "sampleCount": 1,
    "personGeneration": "allow_all",
    "safetySetting": "block_low_and_above",
    "addWatermark": true
  }
}
```

No `storageUri` (nothing is written to Cloud Storage), no `outputOptions`, no `seed`, no `prompt`.
Authentication is `Authorization: Bearer <ADC access token>`, scope
`https://www.googleapis.com/auth/cloud-platform`, obtained server-side with `google-auth-library`.
The response must contain exactly one prediction whose `bytesBase64Encoded` decodes to a JPEG/PNG whose
signature matches its declared `mimeType`; a prediction carrying `raiFilteredReason`, or a 400 whose
message signals a safety/blocked/filtered result, is a safety block. Anything else is a generic
failure. The upstream body is never returned or logged.

### Differences from the merged spec — read before enabling

1. **Enum spelling.** The spec writes `personGeneration = "allow-all"` and
   `safetySetting = "block-low-and-above"` (hyphens). The code sends `allow_all` and
   `block_low_and_above` (underscores), the spelling Google's REST reference uses for the Imagen /
   virtual-try-on parameter family and the same values as Google's SDK enums (`ALLOW_ALL`,
   `BLOCK_LOW_AND_ABOVE`). Semantics are identical. **Both constants live at the top of
   `src/integrations/vertex-try-on/client.ts`, so correcting either is a one-line change once the live
   smoke test (below) shows what the endpoint accepts.**
2. **No prompt.** The spec says to use a fixed server-owned prompt "where the current schema requires
   one". It does not: Google's SDK documents the `prompt` field as *"Not supported for Virtual
   Try-On"*, so none is sent. The spec's safety intent (preserve apparent age, no sexualisation, no
   nudity, no ageing-up of a teen) therefore cannot be expressed to the model; it rests entirely on the
   provider safety filter at `block_low_and_above`, the watermark, and the server-side age and likeness
   gates. Treat the minor-safety live evaluation below as a hard launch criterion, not a formality.

### How this was verified (and what was not)

The sandbox this was built in blocks `docs.cloud.google.com` (network policy), so the official REST
reference pages named in the spec **could not be read**. The request shape above was taken from the
published `@google/genai` 2.27.0 SDK source (`recontextImage` → `:predict`), which is Google's own
implementation of this exact endpoint. That is strong evidence for field names and nesting and weaker
evidence for enum spelling and defaults. **A human must re-read the official pages once before
enabling** (spec §3 references, including the model lifecycle page).

The model is published with a retirement date of **2027-03-15**; re-check for a successor before
production enablement and again before that date.

## Configuration (server-only)

| Variable | Meaning |
| --- | --- |
| `LA_TRY_ON_ENABLED` | Kill switch. Only the exact value `true` enables try-on. Default off. |
| `LA_TRY_ON_GCP_PROJECT_ID` | Google Cloud project billed for Vertex AI. |
| `LA_TRY_ON_GCP_LOCATION` | Optional. Default `asia-southeast1`. |
| `GOOGLE_APPLICATION_CREDENTIALS` | Standard ADC path to the runtime service-account credential. |

Try-on is available only when all of the above are present and well-formed; otherwise the PDP shows no
button, `POST /api/try-on` answers 503 `UNAVAILABLE`, and nothing else on the PDP, cart or checkout
changes. None of these is `NEXT_PUBLIC_`, none is read by `next.config.mjs`, and no credential reaches a
client bundle (a test scans for this).

Placeholders are in `.env.example` and `deploy/vps/env.example`. **No credential is committed.**

### Credentials and least privilege

Use a dedicated service account in the Vertex project with **only** `roles/aiplatform.user`
(`aiplatform.endpoints.predict`). The VPS is not on Google Cloud, so the supported MVP mechanism is a
service-account key file delivered to the VPS out of band (mode 600, never in git or CI logs), mounted
into the `app` container read-only, with `GOOGLE_APPLICATION_CREDENTIALS` pointing at the in-container
path. **`deploy/vps/compose.yml` is deliberately not changed by this PR**: the mount and rotation of that
key is a deployment decision for the operator. Prefer workload-identity federation if the hosting ever
supports it; `google-auth-library` picks it up with no code change.

## Data handling

Nothing durable: no database write, no filesystem write, no Cloud Storage, no analytics payload, no log
line contains an image. Buffers live in one request. The browser holds blob URLs only until the dialog
closes. Vertex processing and retention follow the project's Google Cloud data controls; the buyer copy
says so and does not claim deletion "everywhere". Confirm the project's data-residency and
zero-data-retention posture before enabling (spec §12).

## Limits and abuse controls

| Control | Value | Where |
| --- | --- | --- |
| Shopper photo | exactly one JPEG/PNG, ≤ 7 MB, signature must match declared type | `try-on-request.ts` |
| Request body | ≤ 7 MB + 256 KB, enforced on bytes read | `try-on-endpoint.ts` |
| Product image | trusted-media URL only, HTTPS, ≤ 10 s, ≤ 7 MB, ≤ 2 trusted redirects, JPEG/PNG signature | `product-image.ts` |
| Vertex call | one per accepted request, 45 s timeout (under the 60 s proxy read timeout), no retry | `client.ts` |
| Per client | 6 attempts / 10 minutes (counted before the body is read) | `try-on-rate-limit.ts` |
| Global | 3 generations in flight | `try-on-rate-limit.ts` |
| Same-origin | `Origin` host must equal `Host` (or the first `X-Forwarded-Host`) | `try-on-endpoint.ts` |

The limiter is **in-process**. Production is one app container on one VPS (ADR 0002), so this is the
whole fleet. If the app is scaled to more than one instance the limits become per-instance and must be
revisited. Counters reset on restart. The client key is the same pseudonymous HMAC the checkout limiters
use and needs `BETTER_AUTH_IP_HEADER` in production; without a derivable key the endpoint fails closed.

## Observability

One JSON line per event on stdout (the collected stream in ADR 0002), allow-listed fields only:
`try_on.generation_started`, `try_on.generation_succeeded`, `try_on.generation_failed` (+ `reason`),
`try_on.safety_blocked`, `try_on.rate_limited` (`RATE_LIMITED` / `BUSY`), with `latencyMs`,
`upstreamLatencyMs` and the server-resolved `productSlug`. Never images, base64, credentials, IPs or
upstream bodies. A sustained rise in `safety_blocked` or `generation_failed` is the signal to disable the
feature. The spec's "try-on opened" event is not implemented: it would need a client beacon endpoint for
a count nobody has asked to act on.

## Rollout and rollback

1. Deploy with `LA_TRY_ON_ENABLED=false` (the default). Nothing changes.
2. Staging: configure project + credential, set `LA_TRY_ON_ENABLED=true`, run the live checks below.
3. Owner quality review with consented photos; re-check the model lifecycle page.
4. Limited production enablement, watch the signals above and Vertex cost.

**Rollback / kill switch:** set `LA_TRY_ON_ENABLED=false` (or unset it) in `.env.production` and restart
`app`. The PDP button disappears, the endpoint answers 503, and cart/checkout are untouched. No data
needs cleaning up because none is stored.

## Live verification — NOT yet run

CI and the browser suite use a stub (`tests/a11y-runtime/try-on-fetch-fixture.cjs`) that validates the
request Vertex would receive and never leaves the machine. **No live Vertex call was made while building
this.** Before production enablement a human must, with a non-production project and consented assets
only (never production customer photos; never sourced images of minors):

- [ ] read the official REST reference + model page; confirm the enum spellings in "Differences" and
  that no `prompt` is accepted, and the retirement/successor status;
- [ ] one request per category (Áo dài, Set đồ, Váy/đầm): HTTP 200, exactly one image, garment
  reasonably preserved, person identity/pose/body reasonably preserved, watermark present;
- [ ] record latency and approximate cost per generation;
- [ ] provoke a safety block and confirm the buyer sees the safe message;
- [ ] **minor safety:** at least one consented 13–17 test image with parent/guardian permission, result
  age-appropriate and non-sexualised. This is the single criterion that cannot be satisfied without a
  human-supplied consented image, and it is a launch gate;
- [ ] confirm the Vietnamese buyer privacy copy (owner approval is still open in spec §21).

## Intentionally not included

Database or image history, Cloud Storage output, queues or background jobs, WebP conversion, a provider
framework, age verification or geolocation, a durable consent ledger, an admin UI, a Nano Banana /
OpenAI / other-model fallback, multiple outputs, selected-variant garment imagery.
