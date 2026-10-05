# Spec: Storefront Virtual Try-on with Vertex AI Nano Banana Pro

Status: **Approved and merged 2026-10-04. MVP implemented behind a server kill switch (off by default); see [`docs/integrations/vertex-virtual-try-on.md`](../integrations/vertex-virtual-try-on.md) for the operational contract, the two implementation differences from §3/§8, and the live checks still owed before enablement.**

This spec defines the MVP virtual try-on experience for La.na Design product detail pages (PDPs).

## 1. Objective

Let a shopper upload one photo of themselves and see one AI-generated visualization of the current garment on that photo.

Confirmed owner decisions:

1. The shopper uploads **one photo**.
2. The UI asks for a **front-facing photo**.
3. The garment reference is the PDP's **first trusted product image**.
4. One accepted request returns **one generated result**.
5. Multiple outputs may be added later, but are not part of MVP.
6. La.na Design does **not persist** the uploaded or generated image in its own durable storage.
7. The feature is for **apparel worn on the body**; accessories are excluded.
8. The provider is **Google Cloud Vertex AI** using **Nano Banana Pro / `gemini-3-pro-image`** as a multi-image editing model.
9. MVP supports eligible minors under the age policy in §10.

“Front-facing” is buyer guidance, not a promise that the application will run pose/face classification.

Success means try-on helps visualization without changing price, variant, stock, cart, checkout, order, or recommendation truth.

## 2. Current repository context

Base stack:

- Next.js 16.3.3
- React / React DOM 19.2.0
- TypeScript 5.9.x
- Tailwind CSS 4.x
- Prisma 7.9.1
- pnpm 11.4.0
- Node >= 22.14.0

Relevant existing authorities:

- `src/components/brand/product-detail.tsx` — PDP presentation coordinator.
- `src/commerce/product-media.ts` — trusted product-image validation and canonical first image.
- `src/brand/category.config.ts` — category vocabulary.
- `src/commerce/category-taxonomy.ts` — category identity/membership.
- `tests/domain` and `tests/a11y-runtime` — current domain/browser regression surfaces.

Current top-level category trees:

- `aoDai` — Áo dài
- `setDo` — Set đồ
- `vayDam` — Váy, đầm
- `phuKien` — Phụ kiện

For MVP, `aoDai`, `setDo`, and `vayDam` are eligible apparel trees. `phuKien` is excluded.

## 3. Vertex AI contract

Owner amendment, 2026-10-05: replace the dedicated `gemini-3-pro-image` model because observed
output quality is insufficient.

Current provider contract, checked against Google Cloud documentation on 2026-10-05:

- provider: Google Cloud Vertex AI;
- model: Nano Banana Pro / Gemini 3 Pro Image;
- model id: `gemini-3-pro-image`;
- launch stage: GA;
- location: `global` only;
- request surface: publisher-model `:generateContent`;
- inputs: shopper image + exact trusted garment image as two inline references;
- instruction: one fixed server-owned fidelity/safety prompt;
- output: one candidate, PNG, 2K;
- no forced aspect ratio;
- no model fallback or automatic retry.

Required generation controls:

- `candidateCount = 1`;
- `responseModalities = ["TEXT", "IMAGE"]`;
- `imageConfig.imageSize = "2K"`;
- `imageConfig.imageOutputOptions.mimeType = "image/png"`;
- `imageConfig.personGeneration = "allow_all"`;
- dangerous content, harassment, hate speech and sexually explicit categories use
  `BLOCK_LOW_AND_ABOVE`.

Google documents up to 14 reference images and a 7 MB maximum per inline image for this model. The
storefront intentionally keeps its stricter existing JPEG/PNG + 7 MB input contract.

Important: the model page marks dedicated **Virtual try-on** capability as unsupported. This
implementation uses Gemini image editing for the try-on use case, so garment/person fidelity must be
proven by the controlled live quality gate; it is not guaranteed by a dedicated VTO API contract.

The model page lists retirement on **2027-05-28 or later**. Re-check lifecycle before launch.

Authoritative references:

- https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/3-pro-image
- https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/capabilities/gemini-edit-images
- https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/start

## 4. Product eligibility and runtime availability

### Product eligibility

A product is eligible when all of the following are true:

1. its current category membership belongs to:
   - `aoDai`;
   - `setDo`;
   - `vayDam`;
2. it has a first trusted storefront image from the existing media authority;
3. that exact first image is JPEG/JPG or PNG.

Do not:

- infer eligibility from product names, collections, SKU text, or image recognition;
- fall through to the second product image if the first image is unsupported;
- add WebP conversion solely for MVP.

A product with missing/unknown category membership, no trusted first image, or a first image in unsupported format is not eligible.

The product image's actual byte size is checked only when generation begins. If the trusted JPEG/PNG fetch exceeds Vertex AI's 7 MB per-image limit, fail that generation with a safe message. Do not add a PDP-time network probe merely to decide whether the button should render.

This keeps the owner's “first image” rule exact and avoids adding an image-conversion dependency.

MVP adds no admin eligibility field or database table.

### Runtime availability

Runtime enablement is separate from product eligibility.

The try-on entry point is available only when:

- the server-side feature switch is enabled;
- required Google Cloud project/location configuration is present;
- server-side Google Cloud credentials are available.

Missing provider configuration fails closed and must not break the PDP.

## 5. Product image authority

The garment reference is the exact first trusted image resolved by `src/commerce/product-media.ts`.

The client must not choose or submit a product-image URL.

The server receives product identity, re-resolves the product, verifies try-on eligibility, and obtains the first image through the existing trusted-media contract.

For the outbound product-image fetch:

- reuse the current trusted host/path authority;
- use HTTPS only;
- reject redirects outside the trusted boundary;
- bound timeout and response bytes;
- verify JPEG/PNG content type/signature before sending to Vertex AI.

Do not create a second product-media authority.

## 6. Buyer experience

On an eligible PDP, expose a **Thử đồ** action near the purchase experience without obscuring price, variants, size guide, add-to-cart/preorder, or shipping/returns.

Opening try-on shows an accessible dialog/sheet or equivalent PDP interaction with:

- short explanation;
- one image upload control;
- front-facing-photo guidance;
- local preview;
- likeness-rights acknowledgement;
- age-state selection;
- **Tạo ảnh thử đồ**;
- loading state;
- one generated result;
- **Tạo lại**;
- **Tải ảnh**;
- close/dismiss.

Suggested photo guidance:

- dùng ảnh chính diện;
- thấy rõ người;
- ảnh đủ sáng;
- tránh ảnh quá nhỏ hoặc bị che nhiều.

The UI must state that the result is AI-generated and is **not** a guarantee of size, fit, fabric behavior, exact color, or final real-world appearance.

For the teen path, use plain age-appropriate language and state that the generated image may be inaccurate and should not be used to judge the shopper's body or determine clothing size.

Before each generation, the shopper must confirm:

> Tôi xác nhận đây là ảnh của tôi hoặc tôi có sự đồng ý rõ ràng và các quyền cần thiết để sử dụng hình ảnh của người trong ảnh cho tính năng thử đồ này.

This is a rights/consent representation, not identity verification. MVP does not build face recognition, identity verification, or a durable consent ledger.

## 7. Request lifecycle

Use the simplest synchronous request/response flow that works within the deployed runtime:

1. client sends one shopper image, product identity, likeness acknowledgement, and age state;
2. server validates the request;
3. server re-resolves product/category/media authority;
4. server obtains and validates the first trusted product image;
5. server calls Vertex AI `gemini-3-pro-image`;
6. server receives one inline generated image;
7. server returns the result to the current shopper request;
8. client renders/downloads it;
9. request-local image buffers are released.

MVP does **not** introduce:

- background jobs;
- polling;
- queues;
- durable generation records;
- Cloud Storage output;
- object storage;
- try-on history.

If synchronous request/response proves incompatible with production runtime limits, revise the plan/spec before adding infrastructure.

## 8. Vertex request and safety configuration

Shoppers do not provide a generation prompt. The server owns one fixed instruction that identifies
reference 1 as the shopper and reference 2 as the garment, then asks the model to:

- put exactly that garment on the shopper;
- preserve recognizable identity, face, hair, apparent age, skin tone, body proportions, pose,
  hands, framing, camera perspective, background and lighting;
- preserve garment silhouette, cut, length, color, pattern, texture, seams, trim, logos/graphics and
  visible design details;
- make only the clothing change needed for a physically plausible fit;
- avoid body reshaping, face retouching, unrelated accessory changes, sexualisation, nudity and age
  changes;
- return one high-fidelity fashion visualization, not a collage/split-screen/text image.

Prompt wording is **not** the safety boundary. Provider safety controls and server-side age/consent
gates remain authoritative.

The response may contain text/thought parts, but the application accepts exactly one validated
inline JPEG/PNG image from exactly one candidate. Explicit provider safety blocks fail closed.
Malformed output, extra images, invalid base64, unsupported formats or MIME/signature mismatch are
generic generation failures. No weaker retry or fallback is allowed.

## 9. Upload and cost boundaries

### Shopper upload

MVP accepts exactly one:

- JPEG/JPG;
- PNG.

Each image sent to Vertex AI must be **<= 7 MB**.

Server controls:

- exactly one shopper file;
- bounded total request size;
- allowed MIME type;
- basic file-signature validation;
- reject malformed/unsupported input before paid generation where practical;
- generic safe buyer-facing errors.

Client-side validation is convenience only.

Do not add a dedicated image-decoding/CV dependency solely to prove “front-facing”.

### Cost/abuse

MVP requires bounded rate/concurrency control because each accepted request has external cost.

Do not design a distributed abuse platform by default. The implementation plan should choose the smallest control compatible with current production topology and the guest/login decision.

Cost remains bounded by:

- one Vertex prediction per accepted action;
- one candidate per accepted action;
- no automatic regeneration;
- no catalog pre-generation;
- no hidden background generation;
- no stored history.

## 10. Likeness and minor policy

### Likeness

Application policy requires that try-on use:

- the shopper's own photo; or
- a photo for which the shopper has clear consent and necessary rights.

The server must require the acknowledgement in §6 before contacting Vertex AI.

### Minor policy — owner decision: support minors

Owner decision on 2026-10-04: MVP supports eligible minors.

The request carries exactly one server-enforced age state:

- `adult`
- `teen_eligible_with_guardian`
- `below_digital_consent_age`

Rules:

- `adult`: allowed.
- `teen_eligible_with_guardian`: allowed only for a 13–17 shopper who attests that they have reached the applicable digital-consent age where they live **and** have permission from a parent/legal guardian.
- `below_digital_consent_age`: blocked before any provider call.

The storefront does not calculate jurisdiction or age from location. This is self-attestation, not geolocation, document verification, or identity verification.

This age boundary is a La.na Design product/privacy policy for MVP; do not represent it as a Vertex AI platform requirement.

## 11. Google Cloud authentication and secrets

Vertex AI access is server-only.

Requirements:

- no Google credential is exposed to the browser;
- use server-side Google Cloud authentication such as Application Default Credentials or another reviewed service-account mechanism;
- grant the runtime principal only the permissions needed to invoke the model (the Vertex predict surface requires prediction permission);
- do not commit service-account JSON, access tokens, or private keys;
- do not log credentials or authorization headers.

Exact credential delivery for the VPS is a planning/deployment decision. Do not add a public API key to the client as a shortcut.

## 12. Privacy and data handling

### La.na Design application

The storefront must not persist shopper or output image bytes to:

- Prisma/database tables;
- durable filesystem paths;
- Cloud Storage;
- other object storage;
- analytics payloads;
- application logs.

MVP uses request-scoped/in-memory handling only.

### Google Cloud processing boundary

Buyer-facing privacy copy must distinguish La.na Design storage from Google Cloud processing.

Current Google Cloud documentation states that Google does not use Customer Data to train or fine-tune AI/ML models without the customer's prior permission or instruction. Google Cloud also documents retention/caching and abuse-monitoring cases that can apply depending on service/account configuration.

Therefore the product must **not** promise that the image is “deleted immediately everywhere”.

Minimum truthful disclosure:

- La.na Design does not save the uploaded or generated image in its own durable storage;
- the shopper photo and garment image are sent to Google Cloud Vertex AI to create the result;
- Google Cloud processing/retention follows the configured Google Cloud data controls and applicable service terms.

The implementation must use inline image inputs/outputs and must not introduce a Cloud Storage input or output URI.

## 13. Failure behavior

Try-on is an optional enhancement.

A failure must never alter or block:

- variant selection;
- cart state;
- add-to-cart/preorder;
- checkout/order flow;
- ordinary PDP rendering.

Expected safe failure classes:

- unsupported/non-eligible product;
- invalid/oversized/unsupported image;
- consent/age gate rejected;
- product reference unavailable;
- rate/concurrency limit;
- Vertex authentication/authorization failure;
- upstream timeout/rate limit;
- provider safety block;
- generation failure;
- service temporarily unavailable.

Where retry is reasonable, keep the shopper in the same try-on surface.

A provider safety block is not automatically retryable with different settings.

## 14. Accessibility

Preserve the repository accessibility bar:

- native button/input semantics;
- labeled upload control;
- keyboard-operable open/close/upload/generate/download;
- dialog focus management if a dialog is used;
- visible focus;
- polite loading/status announcements;
- specific validation/error messages;
- generated-image alt text;
- no keyboard trap;
- practical mobile touch targets.

## 15. Observability

Record only non-image operational facts needed to operate the feature:

- try-on opened;
- upload rejected by safe reason class;
- generation started/succeeded/failed;
- provider safety-block count by safe reason class;
- total/upstream latency;
- rate-limit rejection.

Do not record:

- shopper/generated image bytes;
- image base64;
- buyer PII;
- Google credentials/tokens;
- arbitrary URL/query contents.

A sustained spike in provider safety blocks or failures is a reason to disable try-on with the feature switch and investigate using non-image telemetry. No moderation dashboard is required for MVP.

## 16. Testing strategy

CI must stub/mock Vertex AI and must not spend live Google Cloud credits.

### Domain/integration

Cover:

- `aoDai`, `setDo`, `vayDam` eligible; `phuKien` excluded;
- missing/unknown membership excluded;
- missing trusted first media excluded;
- first product image WebP excluded rather than converted or replaced by image 2;
- unsupported/oversized shopper image rejected;
- server ignores/rejects arbitrary client product-image URLs;
- request pins `gemini-3-pro-image`;
- request uses one person image + first trusted product image;
- request pins one candidate, `personGeneration=allow_all`, 2K PNG output, the four reviewed safety categories at `BLOCK_LOW_AND_ABOVE`, and no provider storage URI;
- missing likeness acknowledgement rejected before Vertex;
- missing/unknown age state rejected before Vertex;
- `below_digital_consent_age` rejected before Vertex;
- provider safety block fails closed and cannot trigger a weakened retry;
- upstream failure does not change commerce state;
- no durable image persistence path is introduced;
- Google credentials remain server-only.

### Browser

Cover representative desktop/mobile flows:

- eligible PDP shows **Thử đồ**;
- accessory/non-eligible PDP does not;
- upload preview;
- JPEG/PNG accepted, unsupported format rejected;
- generation stays unavailable until likeness acknowledgement and allowed age state are complete;
- teen path explicitly includes digital-consent-age + guardian attestation;
- blocked age path cannot generate;
- teen path shows age-appropriate AI disclosure;
- loading;
- exactly one success result;
- download;
- failure + retry where appropriate;
- purchase UI still works after try-on failure;
- keyboard/focus behavior;
- existing accessibility gate remains green.

### Manual quality acceptance

Before production enablement, run a small controlled evaluation using consented test photos and representative:

- Áo dài;
- Set đồ;
- Váy/đầm.

Record:

- garment similarity;
- identity/body/pose preservation;
- obvious artifacts;
- latency;
- approximate cost;
- provider safety-block behavior;
- at least one consented 13–17 test case with parent/legal-guardian permission and an age-appropriate, non-sexualized result.

Evaluation images follow the same non-persistence rule as shopper try-on images.

An HTTP 200 alone is not quality acceptance.

## 17. Repository commands

Use the repository's existing commands:

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test:domain
pnpm test
pnpm build
```

For browser coverage, use the existing `tests/a11y-runtime/playwright.config.ts` harness; do not create another browser-test framework.

## 18. Implementation shape / code style

Prefer existing boundaries:

- PDP brand components own presentation;
- commerce/category/media modules remain product truth;
- Vertex integration belongs in one server-only external-integration module under the existing `src/integrations/*` convention;
- orchestration consumes canonical product facts rather than re-deriving them in the UI;
- provider output is untrusted and validated before returning it to the browser.

Do not create a provider abstraction/framework merely because the provider changed during specification. One focused Vertex integration boundary is enough.

No new dependency is assumed by this spec. If implementation needs a Google auth/client package, add only the smallest reviewed dependency and keep credential handling server-only.

## 19. Rollout

Use a server-side feature/kill switch.

Rollout sequence:

1. implementation verified with feature off by default;
2. staging/internal validation;
3. owner quality review with controlled photos;
4. verify current `gemini-3-pro-image` lifecycle/successor status;
5. limited production enablement;
6. monitor latency/error/safety-block/cost;
7. widen if stable.

Turning the switch off must leave normal PDP commerce unchanged.

## 20. Boundaries

### Always

- use current category and trusted-media authorities;
- re-resolve product authority server-side;
- use the exact first trusted product image;
- use Vertex AI `gemini-3-pro-image`;
- use `global` unless a reviewed deployment requirement changes it;
- keep Google Cloud credentials server-only;
- send one shopper image + one product image;
- request one output;
- keep provider safety filtering enabled at the strongest reviewed setting;
- keep provider watermark enabled;
- keep input/output images out of durable app storage;
- keep try-on failure isolated from commerce;
- use truthful AI/privacy disclosure;
- verify browser behavior before production enablement.

### Ask first

- changing provider/model;
- changing eligible category trees;
- using selected-variant imagery instead of first product image;
- adding image conversion;
- storing any shopper/generated image;
- adding history/object storage/database tables;
- adding queue/background jobs;
- adding a new third-party service;
- adding face/body/pose analysis;
- generating more than one result;
- weakening Vertex safety settings;
- processing blocked-age users;
- using shopper images for any purpose beyond requested try-on.

### Never

- expose Google credentials to the browser;
- trust client product-image URLs;
- infer eligibility from product-name keywords;
- log shopper images/base64;
- send images to Cloud Storage in MVP;
- claim the generated image proves fit or size;
- silently persist try-on images;
- silently switch/fallback models;
- weaken a safety block to force output;
- let try-on failure block purchase flows.

## 21. Open questions for owner review

These remain open rather than being guessed:

1. **Guest or login required?**
   - Suggested MVP default: guests allowed, with bounded rate/cost control.
   - **Decided 2026-10-04 (owner):** guests are allowed for their first five attempts; from the sixth, login is required.

2. **Rate limit / concurrency values?**
   - Choose in the implementation plan from expected traffic and measured Vertex cost/latency.
   - **Decided 2026-10-04 (owner):** guest — 1 attempt per minute, 5 in total, then login; member (signed in) — 2 attempts per minute, 10 per day. Implementation reading: "5 in total" is per 24 hours (see `docs/integrations/vertex-virtual-try-on.md`), and every submitted attempt counts. These are cost quotas; they were set without live cost or latency data and can be revised once it exists.

3. **Exact PDP placement**
   - Decide during UI planning against the current purchase composition.

4. **Buyer-facing privacy copy**
   - Approve final Vietnamese wording before production enablement.

5. **Initial rollout scope**
   - All eligible products at once or a limited production gate.

## 22. Acceptance criteria

Implementation is acceptable when:

- [ ] Eligible apparel PDPs expose **Thử đồ** and accessories do not.
- [ ] The exact first trusted product image is used; unsupported first-image format disables try-on rather than falling through or converting.
- [ ] Shopper input accepts exactly one JPEG/PNG image within the provider limit.
- [ ] Product-image byte size is enforced during the generation fetch; PDP rendering does not add a remote size probe.
- [ ] Each request requires likeness-rights acknowledgement.
- [ ] Server-enforced age state is non-overlapping: `adult` and `teen_eligible_with_guardian` allowed; `below_digital_consent_age` rejected.
- [ ] Teen flow shows age-appropriate AI disclosure.
- [ ] Vertex request uses `gemini-3-pro-image` at `global`, two inline reference images, one candidate, 2K PNG output, `personGeneration=allow_all`, the four reviewed safety categories at `BLOCK_LOW_AND_ABOVE`, and the fixed server-owned fidelity prompt.
- [ ] Provider safety blocks fail closed without weaker retry/fallback.
- [ ] One accepted request renders at most one result.
- [ ] La.na Design does not durably persist input/output image bytes.
- [ ] Privacy copy accurately describes the Google Cloud processing boundary.
- [ ] Invalid/untrusted requests fail closed before paid prediction where practical.
- [ ] Usage has bounded rate/concurrency controls.
- [ ] Try-on errors never break PDP/cart/checkout.
- [ ] Browser flow is accessible and covered by the existing Playwright suite.
- [ ] Controlled live quality/cost/latency/minor-safety evidence is reviewed before production enablement.
- [ ] Current model lifecycle is re-checked before launch.
- [ ] Repository lint/typecheck/tests/build pass.
- [ ] No unrelated catalog/commerce refactor is mixed in.

## 23. Explicit non-goals

MVP does not include:

- multiple shopper photos;
- automatic front-pose/face/body classification;
- identity/document/jurisdiction/age verification;
- geolocation for age-policy resolution;
- durable consent ledger;
- processing the blocked age state;
- WebP conversion;
- side/back pose inputs;
- multi-output generation;
- history/account image library;
- persistent generated URLs;
- Cloud Storage output;
- accessory/shoe/jewelry/bag try-on;
- size recommendation/body measurement;
- avatar creation;
- selected-variant-specific garment imagery;
- user-editable prompts;
- background jobs/queues by default;
- admin try-on management;
- automatic provider/model fallback.
