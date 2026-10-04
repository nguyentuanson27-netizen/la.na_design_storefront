# Spec: Storefront Virtual Try-on with GPT Image 2

Status: **Proposed for owner review — 2026-10-04. No implementation is approved by this document until the owner approves this spec and a separate implementation plan.**

This spec defines an MVP virtual try-on experience integrated directly into the La.na Design product detail page (PDP). It is intentionally narrow: one customer photo, one product reference image, one generated result, no durable customer-image storage, and no virtual-try-on history.

## 1. Objective

Let a shopper visualize a wearable La.na Design product on their own front-facing photo before purchase.

The MVP flow is:

1. The shopper opens an eligible PDP.
2. The shopper selects **Thử đồ**.
3. The shopper uploads exactly one front-facing photo of themselves.
4. The server uses the PDP's first trusted product image as the garment/reference image.
5. The server sends the shopper image plus product reference image to OpenAI GPT Image 2.
6. The request returns exactly one generated try-on image.
7. The shopper can view and download the result.
8. The storefront does not persist the uploaded shopper image or generated image in its database or durable object storage.

Success means the feature helps a shopper visualize the garment without changing any catalog, variant, price, stock, cart, checkout, order, or recommendation authority.

## 2. Confirmed owner decisions

Confirmed in the owner interview on 2026-10-04:

1. **Customer input:** exactly one shopper image.
2. **Pose:** the requested input is one front-facing photo.
3. **Product reference:** use the product's first storefront image, normally the first image shown on the PDP.
4. **Output count:** MVP returns exactly one generated image per successful request.
5. **Future output:** multiple generated alternatives may be added later, but are out of scope for MVP.
6. **Application storage:** shopper input and generated output are not stored long-term by the storefront.
7. **Eligibility:** enable virtual try-on only for apparel worn on the body; accessories are excluded.

## 3. Current repository context

Repository stack on the base commit:

- Next.js 16.3.3
- React / React DOM 19.2.0
- TypeScript 5.9.x
- Tailwind CSS 4.x
- Prisma 7.9.1
- pnpm 11.4.0
- Node >= 22.14.0

Relevant current ownership:

- src/components/brand/product-detail.tsx coordinates the PDP media and purchase surfaces.
- src/commerce/product-media.ts owns trusted product-image validation and resolves the canonical first storefront image.
- StorefrontProductMedia.primary and gallery[0] represent the same first trusted image when media exists.
- src/brand/category.config.ts declares the current category vocabulary.
- src/commerce/category-taxonomy.ts owns category identity and persisted category membership semantics.
- tests/domain and tests/a11y-runtime are the existing domain/browser regression surfaces.

Current top-level storefront categories are:

- aoDai — Áo dài
- setDo — Set đồ
- vayDam — Váy, đầm
- phuKien — Phụ kiện

For this MVP, the first three top-level trees are wearable and eligible. phuKien is excluded.

## 4. OpenAI contract verified for this spec

Official OpenAI documentation was reviewed on 2026-10-04.

The owner requested “ChatGPT image-2”. The corresponding API model identifier is:

- model: gpt-image-2

The current OpenAI image API supports gpt-image-2 for both image generation and image editing/reference-image workflows. The image edits endpoint can generate a new image using one or more reference images.

Normative MVP choice:

- use the Images API image-edit workflow;
- use model gpt-image-2;
- provide the shopper photo and the product's first trusted image as the two image references;
- request one output only;
- do not silently upgrade to GPT Image 2.5 or chatgpt-image-latest.

Official sources:

- https://developers.openai.com/api/docs/models/gpt-image-2
- https://developers.openai.com/api/docs/guides/image-generation
- https://developers.openai.com/api/docs/guides/image-prompting
- https://developers.openai.com/api/docs/guides/your-data

The build phase must re-check those official sources before writing the integration because the API is version-sensitive.

## 5. PDP eligibility

A product is eligible only when all of the following are true:

1. It belongs to one current wearable top-level category tree:
   - aoDai
   - setDo
   - vayDam
2. It does not belong to phuKien.
3. The PDP has a trusted first product image from the existing StorefrontProductMedia authority.
4. The feature kill switch is enabled.
5. The server has valid OpenAI credentials.

The implementation must derive category eligibility from the existing category authority. It must not infer apparel from product names, collection names, image content, SKU text, or free-form heuristics.

If a product has no category membership or no trusted first image, the try-on entry point is absent rather than guessing.

This feature does not add admin eligibility fields or a new database table in MVP.

## 6. Product image authority

The reference garment image is the exact first trusted storefront image already resolved by src/commerce/product-media.ts.

The client must not submit an arbitrary product-image URL as authority.

The server must re-resolve or receive a server-authoritative product identity and use the existing trusted media contract to obtain the reference image.

This preserves the current media security boundary:

- HTTPS only;
- reviewed Pancake CDN hosts only;
- reviewed path shapes only;
- no credentials/custom ports/path traversal;
- existing deduplication/ordering rules.

Try-on must not introduce a second product-media parser.

## 7. User experience

### 7.1 Entry point

On an eligible PDP, render a buyer-facing **Thử đồ** action integrated with the product purchase experience.

The exact visual placement belongs to the implementation plan, but it must be part of the PDP and must not replace or obstruct:

- price;
- variant selection;
- size guide;
- add-to-cart / preorder controls;
- shipping and returns facts.

### 7.2 Try-on surface

Activating the action opens an accessible dialog/sheet or equivalent contained PDP interaction.

The surface includes:

- short explanation of the feature;
- one image-upload control;
- front-facing photo guidance;
- local preview of the selected shopper image;
- **Tạo ảnh thử đồ** action;
- loading/progress state;
- generated result;
- retry;
- download result;
- close/dismiss.

Suggested buyer guidance:

- dùng ảnh chính diện;
- thấy rõ người và trang phục hiện tại;
- ảnh đủ sáng;
- tránh ảnh quá nhỏ hoặc bị che nhiều.

The MVP does not run a separate pose/face-quality classifier merely to prove that the photo is front-facing. This is guidance, not a new computer-vision subsystem.

### 7.3 Truthful disclosure

The UI must state that the generated image is an AI visualization and is not an exact guarantee of:

- fit;
- sizing;
- fabric behavior;
- color under real lighting;
- final appearance on the shopper.

The feature must not make body-measurement or fit recommendations in MVP.

## 8. Request lifecycle

The simplest supported lifecycle is synchronous request/response:

1. Client validates basic upload shape.
2. Client sends the shopper image plus product identity to the storefront server.
3. Server re-validates the upload.
4. Server authorizes the product as try-on eligible.
5. Server resolves the first trusted product image.
6. Server fetches that image through the reviewed media boundary with bounded response size/time.
7. Server submits the two image references and a fixed server-owned prompt to OpenAI gpt-image-2.
8. Server receives one base64 image result.
9. Server returns the result to the current shopper request.
10. Client renders the result and may create a browser-local download.
11. Request-local buffers/references are released.

MVP does not require:

- background jobs;
- polling;
- queue infrastructure;
- durable generation records;
- object storage;
- generation history.

If runtime limits make a synchronous request infeasible, stop and revise this spec before introducing queues or persistence.

## 9. OpenAI request contract

The integration is server-only.

Required behavior:

- OpenAI API key never enters client bundles or public environment variables.
- Model is gpt-image-2.
- Use an image-edit/reference workflow rather than text-only generation.
- Input 1 is the shopper photo.
- Input 2 is the first trusted product image.
- n = 1.
- Do not expose prompt editing to shoppers.
- Do not fall back to a different image model without reviewed approval.
- For gpt-image-2, do not set input_fidelity; current official documentation states image inputs are processed at high fidelity automatically.

Exact output size, quality and format are implementation-plan decisions after a small cost/latency/quality evaluation. The output must be portrait-capable. OpenAI currently supports portrait sizes such as 1024x1536, but this spec does not require that exact resolution.

## 10. Prompt contract

The prompt is server-owned and versioned in source.

Its goal is to create a realistic fashion visualization while preserving the shopper as much as practical.

It must instruct the model to:

- treat the shopper photo as the subject identity/pose reference;
- treat the product image as the garment/design reference;
- dress the subject in the referenced product;
- preserve face, skin tone, body proportions, pose and background as much as practical;
- preserve garment silhouette, color, pattern and visible design details as much as practical;
- avoid adding unrelated accessories or changing identity;
- avoid sexualizing or materially changing the shopper's body;
- produce a natural fashion-photo result.

The prompt must not claim that the model can preserve every physical detail exactly.

Prompt revisions that materially change the product promise require test/evaluation evidence.

## 11. Upload validation

The server is the final authority.

Accepted image formats for MVP:

- JPEG/JPG
- PNG
- WebP

Required controls:

- exactly one shopper file;
- bounded raw upload size;
- bounded decoded image dimensions/pixels;
- actual image decoding/validation, not extension-only trust;
- reject malformed/polyglot/non-image input;
- no arbitrary archive/document upload;
- bounded request body;
- generic safe errors.

Proposed starting upload cap: **10 MiB**. This value is not yet owner-approved and may be adjusted in the implementation plan based on runtime and OpenAI constraints.

Client-side validation is convenience only and must not replace server validation.

## 12. Privacy and data handling

### 12.1 Storefront application

The storefront must not persist:

- shopper image bytes;
- generated image bytes;
- face embeddings;
- body measurements;
- image hashes intended to identify a person;
- durable try-on history.

Do not write these images to:

- Prisma/database tables;
- durable filesystem paths;
- object storage;
- analytics payloads;
- application logs.

Temporary in-memory/request-scoped processing is allowed.

Avoid the OpenAI Files API for MVP because the direct Images edit endpoint supports image inputs and does not require creating a durable File object.

### 12.2 OpenAI API boundary

The buyer-facing privacy copy must be accurate about the external processor.

Current OpenAI API documentation states:

- API data is not used to train OpenAI models unless the API customer explicitly opts in;
- the Images generation/edit endpoints have no application-state retention;
- default abuse-monitoring logs may retain customer content for up to 30 days;
- eligible organizations can use approved Zero Data Retention controls, subject to OpenAI requirements and exceptions.

Therefore the storefront must **not** promise “your photo is deleted immediately everywhere”.

The truthful MVP promise is:

- La.na Design does not save the uploaded or generated image to its own durable storage;
- the photo is sent to OpenAI to generate the result;
- OpenAI processing/retention follows the configured OpenAI API data controls.

Final buyer-facing privacy wording is an owner/legal copy decision before production enablement.

## 13. Security and abuse controls

The feature handles untrusted image uploads and a paid external API, so implementation must include:

- server-only OPENAI_API_KEY;
- bounded upload and response sizes;
- image content/type validation;
- product identity re-resolution server-side;
- no arbitrary client-provided remote URL fetching;
- trusted product-media allowlist reuse;
- fetch timeout and redirect policy for the product reference image;
- upstream timeout;
- bounded concurrency;
- rate/cost limiting;
- safe upstream error mapping;
- no raw image/prompt logging;
- no API key or upstream internals in buyer-facing errors.

Exact request quota is unresolved and must be approved in the implementation plan. Do not build an elaborate distributed abuse platform for MVP unless production topology requires it.

## 14. Failure behavior

Try-on is optional enhancement only.

If any stage fails:

- PDP remains usable;
- cart/checkout state is unchanged;
- variant selection is unchanged;
- no purchase operation is blocked;
- user sees a concise retryable error where appropriate.

Expected error classes:

- unsupported product;
- invalid image;
- upload too large;
- product reference unavailable;
- upstream timeout;
- OpenAI rate limit;
- OpenAI safety/refusal;
- generation failure;
- temporary service unavailable.

Do not fall back to a lower-quality model or an undocumented API automatically.

## 15. Cost controls

MVP cost is intentionally bounded:

- one generation per accepted request;
- n = 1;
- no automatic regeneration;
- no hidden background generation;
- no pre-generation for catalog products;
- no saved history thumbnails;
- rate/concurrency limit required.

Before production enablement, the implementation PR must record a measured representative cost and latency sample for the chosen output quality/size.

## 16. Analytics and observability

Operational telemetry may record non-image facts such as:

- try-on opened;
- upload rejected by reason class;
- generation started;
- generation succeeded;
- generation failed by safe reason class;
- total server latency;
- upstream latency;
- rate-limit rejection.

Never include:

- raw image data;
- generated image data;
- customer name/email/phone;
- prompt with customer data;
- arbitrary URL/query contents.

Existing marketing commerce-event contracts are unchanged. Try-on events are product/operational analytics only and must not redefine purchase attribution.

## 17. Accessibility

The feature must preserve the repository's accessibility bar:

- native button/input semantics;
- keyboard-operable open/close/upload/generate/download;
- dialog focus management if a dialog is used;
- visible focus;
- labeled file input;
- loading state announced with a polite status region;
- specific validation/error text;
- generated image has useful alt text such as “Ảnh thử đồ AI cho <product name>”;
- no keyboard trap;
- touch controls remain practical on mobile.

## 18. Testing strategy

### Domain tests

Cover:

- category eligibility:
  - aoDai tree eligible;
  - setDo tree eligible;
  - vayDam eligible;
  - phuKien excluded;
  - missing/unknown membership excluded;
- product without trusted primary media excluded;
- upload schema/type/size validation;
- OpenAI request builder pins gpt-image-2 and one output;
- prompt builder assigns subject/product roles without shopper PII;
- safe error mapping;
- rate/concurrency boundary logic if represented as pure code.

### Integration tests

With a mocked OpenAI boundary:

- server rejects forged/non-eligible product identity;
- server does not trust client product-image URL;
- server uses the first existing trusted product image;
- invalid upload never reaches OpenAI;
- successful request sends two image references and receives one result;
- upstream failure does not alter commerce state;
- no persistence call is made for input/output images;
- API key never appears in public configuration.

### Browser tests

At representative desktop and mobile widths:

- eligible PDP shows Thử đồ;
- accessory PDP does not;
- open/close is keyboard accessible;
- upload preview works;
- invalid file shows an error;
- generate enters a clear loading state;
- success shows exactly one output;
- download action works;
- upstream failure allows retry;
- PDP purchase flow remains usable after try-on failure;
- no unexpected console errors;
- existing Axe gate remains green.

CI must stub OpenAI. CI must not spend live API credits.

### Manual/API acceptance

Before production enablement, run a small controlled evaluation with consented/non-customer test photos and representative products from:

- Áo dài;
- Set đồ;
- Váy/đầm.

Record:

- garment similarity;
- subject identity preservation;
- body/pose stability;
- obvious artifacts;
- generation latency;
- approximate cost.

A technically successful API response is not enough to declare try-on quality acceptable.

## 19. Configuration and rollout

Expected server configuration:

- OPENAI_API_KEY — secret, server only.
- a server-side try-on enable/kill switch.

The exact variable name for the kill switch belongs to the plan.

No database migration is expected for MVP.

Rollout order:

1. disabled by default until implementation verification is complete;
2. staging/internal validation;
3. owner quality review with controlled photos;
4. limited production enablement;
5. monitor latency/errors/cost;
6. widen only if stable.

Turning off the feature must remove/disable the entry point without affecting PDP commerce.

## 20. Boundaries

### Always

- reuse current product category and trusted-media authorities;
- re-resolve product authority on the server;
- keep OpenAI secret server-only;
- use gpt-image-2 unless this spec is amended;
- send one shopper image + one first product image;
- return one output;
- keep try-on failure isolated from commerce;
- avoid durable app storage for input/output images;
- keep truthful AI/privacy disclosure;
- add runtime/browser verification.

### Ask first

- requiring login/account;
- changing the eligible category set;
- changing from the first product image to selected-variant imagery;
- storing uploaded/generated images;
- adding generation history;
- switching model from gpt-image-2;
- adding a queue/background job;
- adding object storage;
- adding a new database table;
- adding a new third-party service;
- adding body/face analysis;
- generating more than one result;
- using shopper images for any purpose beyond the requested generation.

### Never

- expose OPENAI_API_KEY to the browser;
- let the client choose an arbitrary remote product-image URL;
- infer product eligibility from product-name keywords;
- send checkout/contact PII with image requests;
- log raw shopper images;
- claim AI output proves real fit or size;
- silently store try-on images;
- silently upgrade/fallback to another image model;
- let try-on failure block add-to-cart or checkout.

## 21. Open questions for owner review

These are intentionally left open in this spec PR rather than guessed:

1. **Guest vs login:** may anonymous shoppers generate, or must they sign in?
   - Current product recommendation for MVP: allow guests, protected by a bounded rate/cost limit.

2. **Rate limit:** what production quota is acceptable per visitor/IP/session and per time window?
   - Exact numbers should be chosen from cost/traffic expectations.

3. **Upload cap:** approve or change the proposed 10 MiB limit.

4. **Generation quality/size:** choose the default after a short gpt-image-2 quality/cost/latency evaluation.

5. **UI placement:** exact position inside the current PDP purchase composition.

6. **Buyer-facing privacy copy:** approve wording that distinguishes La.na Design non-persistence from OpenAI API processing/retention.

7. **Feature flag rollout:** whether first production release is all eligible products or an internal/limited gate.

These questions may be resolved during PR review. They must be closed before the corresponding implementation choice is considered approved.

## 22. Success criteria

The feature implementation may be considered complete only when:

- [ ] Try-on appears only for the approved wearable category trees.
- [ ] The shopper uploads exactly one front-facing photo.
- [ ] The server uses the existing first trusted product image.
- [ ] The OpenAI request uses gpt-image-2 with the two image references.
- [ ] Each accepted request produces at most one result.
- [ ] Shopper and output image bytes are not persisted by the storefront.
- [ ] Privacy copy accurately describes the OpenAI processing boundary.
- [ ] Invalid/untrusted inputs fail closed before paid generation.
- [ ] Paid usage has bounded rate/concurrency controls.
- [ ] Upstream failure never breaks PDP/cart/checkout.
- [ ] Browser flow is keyboard accessible and passes existing accessibility gates.
- [ ] Live API quality/cost/latency evidence is recorded before production enablement.
- [ ] Lint, typecheck, domain/integration tests, build, and relevant browser tests pass.
- [ ] No unrelated commerce/catalog refactor is mixed into the implementation.
- [ ] Definition of Done in 05_SHARED_REFERENCES.md is satisfied.

## 23. Explicit non-goals

MVP does not include:

- multiple shopper photos;
- side/back pose inputs;
- multi-output generation;
- virtual try-on history;
- account-linked image library;
- persistent generated URLs;
- social sharing backend;
- accessory try-on;
- shoes/jewelry/bags;
- size recommendation;
- body measurement;
- avatar creation;
- selected-color/selected-variant-specific reference images;
- prompt editing;
- background jobs/queues;
- admin try-on management;
- server-side caching of customer generations;
- automatic model upgrades.
