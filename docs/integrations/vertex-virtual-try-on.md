# Vertex AI virtual try-on — Nano Banana Pro

Status: **implemented as a replacement for `virtual-try-on-001`; server kill switch remains off by default.**

Product contract: [storefront virtual try-on spec](../specs/storefront-virtual-try-on.md).

## Provider decision

The dedicated Vertex Virtual Try-On model produced insufficient real-world output quality. The
storefront therefore uses **Nano Banana Pro / Gemini 3 Pro Image** as a multi-image editing model:

- model id: `gemini-3-pro-image`;
- Vertex location: `global` only;
- REST surface: publisher-model `:generateContent`;
- two inline references: shopper first, exact trusted garment second;
- one fixed server-owned fidelity prompt;
- one candidate;
- PNG output at 2K;
- no forced aspect ratio, so the model can choose from the supplied references;
- no retry and no fallback model.

Google's model page does **not** advertise a dedicated Virtual Try-On capability for this model. This
integration is intentionally an image-editing use case, so live garment/person fidelity remains a
product acceptance gate rather than an API guarantee.

The rest of the storefront contract is unchanged: product eligibility, first trusted product image,
likeness acknowledgement, age gate, guest/member quotas, same-origin route, upload/generation
concurrency limits, no durable image storage, and commerce isolation.

Official Google Cloud docs reviewed 2026-10-05:

- https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/3-pro-image
- https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/capabilities/gemini-edit-images
- https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/start

The model page lists GA availability, only `global` as the supported Vertex location, up to 14
reference images, a 7 MB limit for each inline image, 1K/2K/4K output resolutions, and retirement on
2027-05-28 or later.

## Request contract

`POST https://aiplatform.googleapis.com/v1/projects/<project>/locations/global/publishers/google/models/gemini-3-pro-image:generateContent`

Conceptual body (base64 shortened):

```json
{
  "contents": [{
    "role": "user",
    "parts": [
      { "text": "Reference image 1: shopper." },
      { "inlineData": { "mimeType": "image/jpeg", "data": "<shopper>" } },
      { "text": "Reference image 2: garment." },
      { "inlineData": { "mimeType": "image/jpeg", "data": "<garment>" } },
      { "text": "<fixed try-on fidelity prompt>" }
    ]
  }],
  "generationConfig": {
    "candidateCount": 1,
    "responseModalities": ["TEXT", "IMAGE"],
    "imageConfig": {
      "imageSize": "2K",
      "imageOutputOptions": { "mimeType": "image/png" },
      "personGeneration": "allow_all"
    }
  },
  "safetySettings": [
    { "category": "HARM_CATEGORY_DANGEROUS_CONTENT", "threshold": "BLOCK_LOW_AND_ABOVE" },
    { "category": "HARM_CATEGORY_HARASSMENT", "threshold": "BLOCK_LOW_AND_ABOVE" },
    { "category": "HARM_CATEGORY_HATE_SPEECH", "threshold": "BLOCK_LOW_AND_ABOVE" },
    { "category": "HARM_CATEGORY_SEXUALLY_EXPLICIT", "threshold": "BLOCK_LOW_AND_ABOVE" }
  ]
}
```

The fixed prompt tells the model which input is the shopper and which is the garment, asks it to
preserve identity, apparent age, pose, body proportions, framing/background/lighting, and preserve
the garment's silhouette, cut, length, color, pattern, texture, seams, trim and visible graphics. It
explicitly disallows body reshaping, face retouching, unrelated accessory changes, sexualisation,
nudity, age changes, collages, extra people and visible text.

Prompt text is not a permission boundary. Server-side likeness/age gates and provider safety settings
remain authoritative.

## Response trust boundary

Provider output remains untrusted data. The adapter:

1. recognizes explicit provider safety-block signals where available;
2. requires exactly one candidate;
3. ignores text/thought parts;
4. requires exactly one inline image part;
5. validates base64;
6. sniffs JPEG/PNG bytes and requires declared MIME to match;
7. rejects unexpected WebP/HTML/extra-image/malformed output;
8. bounds the whole response body;
9. never returns or logs upstream error bodies.

A 400 is classified as a safety block only for narrow known refusal wording. Schema/request failures
remain generic generation failures so integration faults are not blamed on shopper content.

## Unchanged safety/resource controls

```text
PDP -> /api/try-on -> age/likeness/upload validation
    -> server re-resolves product + exact first trusted image
    -> quotas/concurrency
    -> trusted garment fetch
    -> ADC token
    -> Gemini 3 Pro Image generateContent (once)
    -> validate one output image
    -> browser blob URL
```

Existing bounds stay in force:

- shopper: exactly one JPEG/PNG, <= 7 MB, signature checked;
- garment: exact first trusted JPEG/PNG, <= 7 MB, redirect-safe trusted fetch;
- body read: bounded and timed;
- provider phase: one 45 s deadline over auth + generation;
- no automatic retry or weaker fallback;
- guest/member attempt quotas unchanged;
- upload/generation concurrency caps unchanged;
- no input/output image bytes in Prisma, filesystem, Cloud Storage, analytics or logs.

## Configuration

| Variable | Meaning |
| --- | --- |
| `LA_TRY_ON_ENABLED` | Kill switch; only exact `true` enables try-on. |
| `LA_TRY_ON_GCP_PROJECT_ID` | Google Cloud project billed for Vertex AI. |
| `GOOGLE_APPLICATION_CREDENTIALS` | ADC credential path/runtime identity. |

`LA_TRY_ON_GCP_LOCATION` is retired configuration. If an existing runtime still sets a non-empty
value other than `global`, the feature fails closed. Remove the old regional value from production
configuration.

Credentials remain server-only. Use a dedicated runtime identity with least privilege for Vertex
online prediction; no Google credential or token may reach the browser.

## Rollout and rollback

1. Deploy with `LA_TRY_ON_ENABLED=false`.
2. Remove stale regional `LA_TRY_ON_GCP_LOCATION`.
3. Enable only in a non-production project and run controlled consented comparisons.
4. Compare Áo dài / Set đồ / Váy-đầm on the same shopper + garment inputs.
5. Record garment fidelity, identity/body/pose preservation, artifacts, latency, cost and safety.
6. Run the required consented 13–17 case with guardian permission.
7. Only then do a limited production enablement and monitor existing failure/safety/latency signals.

Rollback is unchanged: set `LA_TRY_ON_ENABLED=false` and restart the app. No image cleanup is needed
because the application does not durably store try-on inputs or outputs.

## Verification status

Deterministic tests prove request shape, config fail-closed behavior, output validation, timeout/error
mapping and browser wiring against a hermetic fixture. They cannot prove generated-image quality.

A live Nano Banana Pro quality evaluation with consented inputs remains a launch blocker. An HTTP 200
or green fixture is not evidence that garment fidelity is acceptable.
