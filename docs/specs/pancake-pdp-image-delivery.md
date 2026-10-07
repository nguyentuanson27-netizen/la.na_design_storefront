# Spec: Pancake PDP image delivery under 3 MB

**Status:** Implementation contract for `feat/pancake-pdp-image-compression`
**Baseline:** `main@0e2b6f6a136ae1dde7de1fab93c8d63121463907`

## Objective

Every successful product-gallery image response delivered by the La.na Design PDP must be strictly below **3,000,000 bytes**, while Pancake remains the source of truth for the original image URL.

This change is about storefront delivery, not mutating Pancake media and not persisting a second media library in PostgreSQL or a new object-storage provider.

## Tech stack

- Next.js 16.3.3 / React 19.2.0
- TypeScript 5.9.x
- Node >= 22.14
- `sharp` 0.35.4 as an explicit production dependency for bounded server-side transcode/resize
- Existing strict Pancake image trust contract in `src/commerce/product-media.ts`

## Commands

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

## Project structure

- `src/commerce/product-image-delivery.ts`: pure byte/width policy and bounded retry schedule
- `src/integrations/pancake/product-image-delivery.ts`: trusted fetch + Sharp transcode
- `src/app/api/product-image/route.ts`: thin same-origin GET binding
- `src/components/brand/pdp-image-loader.ts`: `next/image` custom loader URL builder
- `src/components/brand/product-media-stage.tsx`, `product-gallery.tsx`: PDP-only wiring
- `tests/domain/product-image-delivery.test.ts`: pure contract tests
- `tests/integrations/pancake-product-image-delivery.test.ts`: trust/fetch/transcode tests

## Delivery contract

1. Original Pancake URLs remain unchanged in ProductMirror / StorefrontProductMedia.
2. PDP gallery/stage images use a same-origin loader endpoint.
3. The endpoint re-validates the source with `parseTrustedProductImageUrl`; redirects are manual and every hop must remain inside the same reviewed Pancake trust boundary.
4. Source bodies are bounded before decode. Oversized, malformed, untrusted, timeout, or unsupported images fail closed.
5. Output is WebP, responsive to the requested PDP width, metadata-free by Sharp default, and strictly `< 3_000_000` bytes.
6. Compression uses a bounded sequence of quality/width attempts; there is no unbounded retry loop.
7. Merchant feeds, search data, try-on source resolution, product cards, and Pancake itself continue to use the original trusted URL.
8. The route is Node runtime only because Sharp/libvips is a server dependency.

## Security and performance boundaries

- No arbitrary remote fetch / SSRF: exact reviewed Pancake hosts/path shapes only.
- Redirect count, timeout, input byte size, input pixel count, requested widths, and compression attempts are bounded.
- No provider/upstream error body is reflected to the client.
- Successful responses advertise cacheable media semantics with a finite freshness window; failures are not cached long-term.
- A malicious query cannot select arbitrary image widths; only the reviewed responsive width set is accepted.

## Success criteria

- [ ] Every successful optimizer response has `Content-Type: image/webp` and body length `< 3_000_000`.
- [ ] A source larger than the bounded input limit is rejected before full buffering.
- [ ] Untrusted URLs and untrusted redirects cause zero external follow-up fetches.
- [ ] PDP media components generate same-origin optimizer URLs instead of exposing the Pancake URL as the browser image request.
- [ ] Original media URLs remain unchanged in commerce/domain models and non-PDP consumers.
- [ ] Focused tests, full `pnpm test`, lint, typecheck and production build pass.

## Non-goals

- Uploading compressed derivatives back to Pancake.
- Adding S3/R2/Cloudinary or a new durable media store.
- Rewriting Merchant/feed image URLs.
- Compressing editorial/brand assets or every product card in this slice.
