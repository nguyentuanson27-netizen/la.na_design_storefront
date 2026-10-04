# Vertex AI virtual try-on (`virtual-try-on-001`)

Status: **Implemented behind a server kill switch, off by default.** Product contract:
[`docs/specs/storefront-virtual-try-on.md`](../specs/storefront-virtual-try-on.md). This document is the
operational truth for the code: how it is wired, what the Vertex request is, what must be configured,
how to turn it off, and what is still waiting on a human.

## Flow

```text
PDP (server)   resolveProductTryOn()        flag on + category (aoDai|setDo|vayDam) + exact first
                                            trusted image is JPEG/PNG  ->  {productSlug} | null
Browser        BrandTryOnTrigger +          "Thử đồ" link on the size-guide line opens a 3-step dialog;
               BrandTryOnDialog/useTryOn    the form is not on screen while a request runs; multipart
                                            POST /api/try-on: photo, productSlug, likenessAcknowledged,
                                            ageState
Route          handleTryOnPost()            same-origin (Origin host == Host), multipart only,
                                            Content-Length and streamed-byte cap, 30 s body deadline,
                                            client key
Service        createTryOnService()         flag -> guest|member quota -> upload slot -> read body ->
                                            validate request -> release upload slot -> re-resolve
                                            product -> eligibility -> generation slot -> trusted
                                            product image -> Vertex (once)
Vertex         createVertexTryOnClient()    one :predict, one candidate, response validated
Browser        <img src=blob:> + download   nothing stored; closing the dialog drops and revokes it
```

Files: `src/commerce/try-on-*.ts` (policy, eligibility, request, service, endpoint, rate limit,
runtime wiring), `src/integrations/vertex-try-on/*` (the only Vertex/Google code),
`src/operations/try-on-observability.ts`, `src/app/api/try-on/route.ts`,
`src/components/headless/{use-try-on,try-on-model}.ts`, `src/components/brand/try-on-dialog.tsx`.

### Dialog

The entry point is a text link ("Thử đồ", with " bằng ảnh của bạn" from the `sm` breakpoint up) on the
same line as "Hướng dẫn chọn size", so the purchase panel gains no row. The dialog is a bottom sheet on
phones and a 440 px modal from `sm`, in three steps: (1) choose a photo, (2) age and confirmation
(age chips, the full teen attestation under a short chip, the exact likeness acknowledgement, privacy
line), (3) result. Loading, success and failure are all step 3, so nothing the request was built from
can be edited while it runs. "Tạo lại" returns to step 2 with the age kept and the acknowledgement asked
again; a provider safety block drops the photo and returns to step 1 with the explanation. Moving
between steps moves focus to the new step's heading. Step logic lives in `try-on-model.ts`
(`nextTryOnStep`) and is unit-tested; the server gates are unchanged by the layout.

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
    "personGeneration": "allow-all",
    "safetySetting": "block-low-and-above",
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

### Notes on the request

1. **Enum spelling is the documented REST value.** The official `VirtualTryOnModelParams` reference
   documents the hyphenated values — `personGeneration`: `dont-allow` / `allow-adult` / `allow-all`;
   `safetySetting`: `block-low-and-above` / `block-medium-and-above` / … — and that is what is sent. An
   earlier revision of this code sent underscore forms on the strength of Google's SDK; that was wrong:
   the SDK's enums (`ALLOW_ALL`, `BLOCK_LOW_AND_ABOVE`) are passed through unconverted and are not
   evidence for the wire value. A test pins the exact strings, but a test cannot show the live endpoint
   accepts them — that is what the live smoke test below is for.
2. **No prompt.** The spec says to use a fixed server-owned prompt "where the current schema requires
   one". It does not: Google's SDK documents the `prompt` field as *"Not supported for Virtual
   Try-On"*, so none is sent. The spec's safety intent (preserve apparent age, no sexualisation, no
   nudity, no ageing-up of a teen) therefore cannot be expressed to the model; it rests entirely on the
   provider safety filter at `block-low-and-above`, the watermark, and the server-side age and likeness
   gates. Treat the minor-safety live evaluation below as a hard launch criterion, not a formality.
3. **400 classification is deliberately narrow.** A safety block (which clears the shopper's photo and
   emits `try_on.safety_blocked`) is a prediction carrying `raiFilteredReason`, or an HTTP 400 whose
   top-level `error.message` or string `error.details[].detail` (first 8 entries, each bounded) contains
   known refusal wording: Google's documented "violate Google's Responsible AI practices" (straight or
   typographic apostrophe), `blocked by safety filters`, `safety filter threshold`, `Responsible AI
   filtered/blocked`, or `Support codes: <n>`. The Responsible AI guide documents the support code as
   living in `details[].detail`, so both places are read. A request-validation 400 (for example
   `invalid safetySetting`) is a plain generation failure, so an integration fault is never blamed on the
   shopper's content. These strings come from Google's documentation and have not been confirmed against
   the live endpoint.

### How this was verified (and what was not)

The sandbox this was built in blocks `docs.cloud.google.com` (network policy), so the official REST
reference pages named in the spec **could not be read by the author**. The request shape above was
taken from the published `@google/genai` 2.27.0 SDK source (`recontextImage` → `:predict`), which is
Google's own implementation of this endpoint: good evidence for field names and nesting, none for enum
spelling (see note 1, corrected in review against the official parameters page). **A human must
re-read the official pages once before enabling** (spec §3 references, including the model lifecycle
page).

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
| Provider phase | one Vertex call per accepted request; **one 45 s deadline covers the access-token acquisition and the prediction** (under the 60 s proxy read timeout), so a stalled token refresh cannot pin a generation slot; the auth transport also has a 15 s timeout so an abandoned token request closes; no retry | `client.ts`, `google-auth.ts` |
| Guest quota | 1 attempt per minute, 5 in total (24 h window); from the 6th, `LOGIN_REQUIRED` (401) and the dialog offers sign-in. Owner decision 2026-10-04. Counted before the body is read | `try-on-rate-limit.ts` |
| Member quota | 2 attempts per minute, 10 per day (24 h window); over the day, `DAILY_LIMIT_REACHED` (429). Any signed-in account is a member. Owner decision 2026-10-04 | `try-on-rate-limit.ts` |
| Uploads in flight | 4 bodies being received/parsed at once, taken before the body is read and released after the photo is validated; 30 s body-read deadline | `try-on-rate-limit.ts`, `try-on-endpoint.ts` |
| Generations in flight | 3 (outbound image fetch + Vertex only) — provisional resource bound | `try-on-rate-limit.ts` |
| Same-origin | `Origin` host must equal `Host` (or the first `X-Forwarded-Host`) | `try-on-endpoint.ts` |

The upload cap is a resource bound for the container (a request in the upload phase holds roughly
three copies of a ≤ 7 MB body, so four bound that phase to the order of 100 MB), not a traffic or cost
quota; it is separate from the generation cap so a slow upload can never occupy a Vertex slot. The
generation cap of 3 is likewise a provisional resource bound that no live measurement has tuned.

The guest and member quotas are the owner's decision (spec §21, 2026-10-04), made without live Vertex
cost or latency data. Reading choices to be aware of, each easy to change in `try-on-rate-limit.ts`:

- **"5 in total" for a guest is per 24 hours, not for life.** A lifetime count would need durable
  per-visitor state (a database row or a long-lived cookie), which this MVP deliberately does not keep.
  A guest is identified by the trusted proxy's client address, so people behind one shared address
  share one allowance, and a guest who changes address starts a fresh one.
- **The member "10 a day" is a 24 h window from the first attempt,** not a calendar day in Vietnam time.
- **Every submitted attempt counts,** including one that later fails (a provider error, a timeout, a
  safety block). A refused attempt (rate-limited, login-required, over the daily limit) does not.
- **A member is any signed-in account** and is keyed by account id, independent of address. If the
  session lookup fails the request is treated as a guest, never as a member, so a fault can only make
  the limit stricter.

The limiter is **in-process**. Production is one app container on one VPS (ADR 0002), so this is the
whole fleet. If the app is scaled to more than one instance the limits become per-instance and must be
revisited. Counters reset on restart, which for the daily allowances means a restart gives everyone a fresh day. The client key is the same pseudonymous HMAC the checkout limiters
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
