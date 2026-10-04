# Spec: Storefront Virtual Try-on with GPT Image 2

Status: **Proposed for owner review — 2026-10-04. Spec only; implementation requires a separate reviewed plan.**

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

Important distinction: “front-facing” is buyer guidance in MVP, not a promise that the application will run pose/face classification. The server validates that one supported image was uploaded; it does not build a separate computer-vision gate.

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

- `src/components/brand/product-detail.tsx` coordinates PDP presentation.
- `src/commerce/product-media.ts` validates product media and resolves the canonical first trusted image.
- `src/brand/category.config.ts` declares the category vocabulary.
- `src/commerce/category-taxonomy.ts` owns category identity/membership rules.
- `tests/domain` and `tests/a11y-runtime` are the existing unit/domain and browser regression surfaces.

Current top-level category trees:

- `aoDai` — Áo dài
- `setDo` — Set đồ
- `vayDam` — Váy, đầm
- `phuKien` — Phụ kiện

For MVP, `aoDai`, `setDo`, and `vayDam` are eligible apparel trees. `phuKien` is excluded.

## 3. OpenAI contract

Official OpenAI documentation was re-checked on 2026-10-04.

The requested API model is:

- `gpt-image-2`

Normative MVP integration:

- use `POST /v1/images/edits` / the equivalent official SDK image-edit call;
- provide two image references:
  1. shopper photo;
  2. first trusted product image;
- set `n = 1`;
- do not set `input_fidelity` for `gpt-image-2`; current docs state image inputs are already processed at high fidelity;
- do not silently upgrade or fall back to another image model.

OpenAI currently documents that the image edit workflow can use one or more reference images and that GPT Image responses return base64 image data.

Authoritative references:

- https://developers.openai.com/api/docs/models/gpt-image-2
- https://developers.openai.com/api/docs/guides/image-generation
- https://developers.openai.com/api/docs/guides/image-prompting
- https://developers.openai.com/api/docs/guides/your-data

Because the API is version-sensitive, the implementation PR must re-check the official docs before coding against it.

## 4. Eligibility and runtime availability

### Product eligibility

A product is eligible when:

1. its current category membership belongs to one of the approved apparel trees:
   - `aoDai`
   - `setDo`
   - `vayDam`
2. it has a trusted first storefront image from the existing product-media authority.

Do not infer eligibility from product names, collection names, SKU text, image recognition, or free-form heuristics.

A product with missing/unknown category membership or no trusted first image is not eligible.

MVP adds no admin field, database table, or per-product try-on toggle.

### Runtime availability

Runtime enablement is separate from product eligibility.

The entry point is available only when the server-side feature switch is enabled and required OpenAI server configuration is present. Missing configuration fails closed and must not break the PDP.

## 5. Product image authority

The garment reference is the exact first trusted image already resolved by `src/commerce/product-media.ts`.

The client must not choose or submit an arbitrary product-image URL.

The server receives a product identity, re-resolves the product, verifies try-on eligibility, and obtains the first image through the existing trusted-media contract.

Do not create a second product-media parser.

## 6. Buyer experience

On an eligible PDP, expose a **Thử đồ** action near the purchase experience without obscuring price, variants, size guide, add-to-cart/preorder, or shipping/returns.

Opening try-on shows an accessible dialog/sheet or equivalent contained PDP interaction with:

- a short explanation;
- one image upload control;
- front-facing-photo guidance;
- a local preview;
- **Tạo ảnh thử đồ**;
- loading state;
- one generated result;
- **Tạo lại**;
- **Tải ảnh**;
- close/dismiss.

Suggested guidance:

- dùng ảnh chính diện;
- thấy rõ người;
- ảnh đủ sáng;
- tránh ảnh quá nhỏ hoặc bị che nhiều.

The UI must state that the result is an AI visualization, not a guarantee of size, fit, fabric behavior, exact color, or final real-world appearance.

Before generation, the shopper must explicitly confirm:

> Tôi xác nhận đây là ảnh của tôi hoặc tôi có sự đồng ý rõ ràng và các quyền cần thiết để sử dụng hình ảnh của người trong ảnh cho tính năng thử đồ này.

This acknowledgement is required per generation request. It is a rights/consent representation, not identity verification: MVP does not build face recognition, identity verification, or a durable consent ledger. The server must require the acknowledgement in the generation request rather than relying on a client-only disabled button.

MVP does not provide body measurement or size recommendations.

## 7. Request lifecycle

Use the simplest request/response flow that works within the deployed runtime:

1. client sends one shopper image plus product identity;
2. server validates the request;
3. server re-resolves product/category/media authority;
4. server obtains the first trusted product image;
5. server calls `gpt-image-2` image edit with the two image inputs and a server-owned prompt;
6. server returns one generated image to the current request;
7. client renders/downloads it;
8. request-local image buffers are released.

MVP does **not** introduce:

- background jobs;
- polling;
- queues;
- durable generation records;
- object storage;
- try-on history.

If synchronous request/response proves incompatible with actual production runtime limits, stop and revise the plan/spec before adding infrastructure.

## 8. Prompt contract

The prompt is server-owned and versioned in source. Shoppers do not edit it.

The prompt should:

- identify image 1 as the shopper/subject reference;
- identify image 2 as the garment/design reference;
- place the referenced garment naturally on the shopper;
- preserve identity, pose, body proportions, skin tone, framing, and background as much as practical;
- preserve garment silhouette, color, pattern, and visible design details as much as practical;
- avoid unrelated accessories or identity/body changes;
- produce a realistic fashion visualization.

These are quality targets, not guarantees.

Prompt changes that materially change the buyer-facing result should be evaluated against the same representative test set used for launch acceptance.

## 9. Upload, security, and cost boundaries

The feature handles untrusted uploads and a paid external API.

### Upload

MVP accepts one:

- JPEG/JPG;
- PNG;
- WebP.

Server controls:

- exactly one file;
- bounded request/file size;
- content type plus basic file-signature validation; do not trust filename/extension alone;
- reject malformed/unsupported input before paid generation where practical;
- generic safe errors.

Do not add a dedicated image-decoding/CV dependency solely to prove “front-facing” or to perform pixel-level analysis unless implementation evidence shows it is necessary.

Proposed starting upload cap: **10 MiB**. This remains an owner-review item.

### External boundary

- `OPENAI_API_KEY` is server-only.
- Never expose the key in client/public env.
- Never log raw shopper/generated images.
- Never send checkout/contact PII with the request.
- Never trust a client-supplied remote product-image URL.
- Product-image fetching must remain inside the reviewed trusted-media allowlist and use bounded timeout/redirect behavior.
- Map upstream errors to safe buyer-facing errors.

### Cost/abuse

MVP requires bounded rate/concurrency control because each accepted request has external cost.

Do not design a distributed abuse platform by default. The implementation plan should choose the smallest control compatible with the current single-app production topology and the guest/login decision.

Cost remains bounded by:

- `n = 1`;
- no automatic regeneration;
- no catalog pre-generation;
- no hidden background generation;
- no durable history.

## 10. Privacy, likeness consent, and minors

### Likeness consent

OpenAI's current Service Terms require express consent and all necessary rights to reproduce a person's likeness.

Therefore:

- try-on may be used only with the shopper's own photo or a photo for which the shopper has express consent and the necessary rights;
- each generation request requires the acknowledgement defined in §6;
- a missing acknowledgement fails before the OpenAI call;
- MVP does not attempt to verify identity or persist a consent record.

### Minor policy — blocking owner decision

Whether this product serves people under 18 is **not yet approved**.

This is a blocking product/privacy decision, not an implementation detail. Production try-on must remain disabled until the owner chooses one of these policies:

1. **18+ only** — simplest MVP. Add age eligibility/acknowledgement appropriate to the approved policy; do not build a general age-verification platform unless legally required.
2. **Support minors** — implementation must follow the current OpenAI Under-18 API Guidance and applicable law. In particular, OpenAI states that personal data of children under 13 or the applicable age of digital consent must not be processed without first implementing Zero Data Retention, and applications serving minors require additional age-appropriate safeguards.

The implementation team must not silently choose either policy.

## 11. Privacy and data handling

### La.na Design application

The storefront must not persist shopper or output image bytes to:

- Prisma/database tables;
- durable filesystem paths;
- object storage;
- analytics payloads;
- application logs.

MVP should use request-scoped/in-memory handling only.

Do not use OpenAI Files API just to stage these images when the direct image-edit endpoint can accept image inputs.

### OpenAI processing boundary

Buyer-facing privacy copy must distinguish application storage from OpenAI processing.

Current OpenAI API documentation states:

- API data is not used to train OpenAI models unless the API customer explicitly opts in;
- `/v1/images/edits` has no application-state retention;
- default abuse-monitoring logs may retain customer content for up to 30 days;
- image endpoints are eligible for Zero Data Retention for approved organizations, subject to documented limitations.

Therefore the product must **not** promise that the photo is “deleted immediately everywhere”.

The minimum truthful disclosure is:

- La.na Design does not save the uploaded or generated image in its own durable storage;
- the uploaded photo is sent to OpenAI to generate the result;
- OpenAI processing/retention follows the OpenAI API data controls configured for the account.

Zero Data Retention is optional for the default adult-only/non-minor path. If the owner chooses to support minors in a way covered by OpenAI's Under-18 guidance, any ZDR requirement in that guidance becomes mandatory for the affected users before production enablement.

## 12. Failure behavior

Try-on is an optional enhancement.

A failure must never alter or block:

- variant selection;
- cart state;
- add-to-cart/preorder;
- checkout/order flow;
- ordinary PDP rendering.

Expected safe failure classes:

- unsupported product;
- invalid/oversized image;
- product reference unavailable;
- rate/concurrency limit;
- upstream timeout/rate limit;
- upstream safety/refusal;
- generation failure;
- service temporarily unavailable.

Where retry is reasonable, keep the shopper in the same try-on surface and allow retry.

Do not silently fall back to another model.

## 13. Accessibility

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

## 14. Observability

Record only non-image operational facts needed to operate the feature:

- try-on opened;
- upload rejected by safe reason class;
- generation started/succeeded/failed;
- total/upstream latency;
- rate-limit rejection.

Do not record raw image bytes, generated images, shopper PII, or arbitrary URL/query contents.

Existing marketing commerce-event contracts remain unchanged.

## 15. Testing strategy

CI must stub/mock OpenAI and must not spend live API credits.

### Domain/integration

Cover:

- apparel category trees eligible; `phuKien` excluded;
- missing/unknown membership excluded;
- missing trusted first media excluded;
- unsupported/oversized upload rejected;
- server ignores/rejects arbitrary client product-image URLs;
- request pins `gpt-image-2` and one output;
- successful orchestration sends shopper + first trusted product image;
- missing likeness-rights acknowledgement is rejected before the OpenAI call;
- upstream failure maps safely and does not change commerce state;
- no durable image persistence path is introduced;
- API key is server-only.

### Browser

Cover representative desktop/mobile flows:

- eligible PDP shows **Thử đồ**;
- accessory/non-eligible PDP does not;
- upload preview;
- generation stays unavailable until the likeness-rights acknowledgement is checked;
- loading;
- exactly one success result;
- download;
- failure + retry;
- purchase UI still works after a try-on failure;
- keyboard/focus behavior;
- existing accessibility gate remains green.

### Manual quality acceptance

Before production enablement, run a small controlled evaluation using consented test photos and representative:

- Áo dài;
- Set đồ;
- Váy/đầm.

Record enough evidence to decide:

- garment similarity;
- identity preservation;
- obvious artifacts;
- latency;
- approximate cost.

A HTTP 200 alone is not quality acceptance.

## 16. Repository commands

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

For the browser slice, add the try-on spec to the existing `tests/a11y-runtime/playwright.config.ts` suite and run the existing Playwright harness; do not create a second browser-test framework.

## 17. Implementation shape / code style

Prefer existing boundaries:

- PDP brand components own presentation;
- commerce/category/media modules remain product truth;
- a new OpenAI image client, if needed, belongs under the existing `src/integrations/*` external-integration boundary;
- orchestration should be server-only and should consume canonical product facts rather than re-derive them in the UI;
- tests should exercise pure policy separately from external I/O where useful.

No new dependency is assumed by this spec. Adding one requires review.

Do not turn MVP into a general image-generation framework.

## 18. Rollout

Use a server-side feature/kill switch.

Rollout sequence:

1. implementation verified with feature off by default;
2. staging/internal quality check;
3. owner review with controlled photos;
4. limited production enablement;
5. monitor latency/error/cost;
6. widen if stable.

Turning the switch off must leave normal PDP commerce unchanged.

## 19. Boundaries

### Always

- use current category and trusted-media authorities;
- re-resolve product authority server-side;
- keep OpenAI secret server-only;
- use `gpt-image-2`;
- send one shopper image + first trusted product image;
- request one output;
- keep input/output images out of durable app storage;
- keep try-on failure isolated from commerce;
- use truthful AI/privacy disclosure;
- verify browser behavior before production enablement.

### Ask first

- requiring login/account;
- changing eligible category trees;
- using selected-variant imagery instead of the first product image;
- storing any shopper/generated image;
- adding history/object storage/database tables;
- adding queue/background jobs;
- switching image model;
- adding a new third-party service;
- adding face/body/pose analysis;
- generating more than one result;
- using shopper images for any purpose beyond the requested try-on.

### Never

- expose `OPENAI_API_KEY` to the browser;
- trust client product-image URLs;
- infer eligibility from product-name keywords;
- log shopper images;
- claim the generated image proves fit or size;
- silently persist try-on images;
- silently upgrade/fallback models;
- let try-on failure block purchase flows.

## 20. Open questions for owner review

These remain open rather than being guessed:

1. **Minor policy — BLOCKING**
   - Choose **18+ only** or **support minors** before approving production implementation.
   - Suggested simplest MVP: 18+ only, without building a general age-verification platform unless required.

2. **Guest or login required?**
   - Suggested MVP default: guests allowed, with bounded rate/cost control.

3. **Rate limit / concurrency values?**
   - Choose in the implementation plan from expected traffic and measured generation cost.

4. **Upload cap**
   - Approve or change the proposed 10 MiB.

5. **Output quality/size**
   - Choose after a small `gpt-image-2` latency/cost/quality comparison; portrait output is preferred.

6. **Exact PDP placement**
   - Decide during UI planning against the current purchase composition.

7. **Buyer-facing privacy copy**
   - Approve final Vietnamese wording before production enablement.

8. **Initial rollout scope**
   - All eligible products at once or a limited production gate.

## 21. Acceptance criteria

Implementation is acceptable when:

- [ ] Eligible apparel PDPs expose **Thử đồ** and accessories do not.
- [ ] UI requests one front-facing shopper photo; server accepts exactly one supported image without adding pose classification.
- [ ] Each generation request requires an explicit likeness-rights acknowledgement and rejects missing acknowledgement before the OpenAI call.
- [ ] The owner-approved minor policy is implemented; production remains disabled while that decision is unresolved.
- [ ] Server re-resolves the product and uses the existing first trusted product image.
- [ ] The external request uses `gpt-image-2`, two image references, and one output.
- [ ] One accepted request renders at most one result.
- [ ] La.na Design does not durably persist input/output image bytes.
- [ ] Privacy copy accurately describes the OpenAI processing boundary.
- [ ] Invalid/untrusted requests fail closed before paid generation where practical.
- [ ] Usage has bounded rate/concurrency controls.
- [ ] Try-on errors never break PDP/cart/checkout.
- [ ] Browser flow is accessible and covered by the existing Playwright suite.
- [ ] Controlled live quality/cost/latency evidence is reviewed before production enablement.
- [ ] Repository lint/typecheck/tests/build pass.
- [ ] No unrelated catalog/commerce refactor is mixed in.

## 22. Explicit non-goals

MVP does not include:

- multiple shopper photos;
- automatic front-pose/face/body classification;
- identity verification or a durable consent ledger;
- side/back pose inputs;
- multi-output generation;
- history/account image library;
- persistent generated URLs;
- accessory/shoe/jewelry/bag try-on;
- size recommendation/body measurement;
- avatar creation;
- selected-variant-specific garment imagery;
- prompt editing;
- background jobs/queues by default;
- admin try-on management;
- automatic model upgrades.
