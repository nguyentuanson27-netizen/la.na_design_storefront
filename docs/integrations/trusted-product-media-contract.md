# Trusted product-image media contract

Status: **Current storefront media trust contract.**

This document defines the storefront media resolution and trust contract used for mirrored Pancake product media.

## Architectural Boundary

The storefront uses a pure, synchronous media resolver ([`src/commerce/product-media.ts`](../../src/commerce/product-media.ts)) over product-level (`ProductMirror.primaryImageUrl`) and variation-level (`VariantMirror.pancakeImageUrls`) media URIs.

The same reviewed trust boundary is mirrored by the admin product-health SQL predicate and by Next.js image configuration so that storefront rendering, admin health checks, and the image optimizer do not disagree about which remote image URLs are acceptable.

## Media Trust Policy

Pancake responses are untrusted external inputs. The media resolver enforces strict fail-closed trust rules.

### Images

1. **Protocol**: Strictly `https:` (rejects `http:`, `ftp:`, `data:`, `javascript:`, `file:`, etc.).
2. **Reviewed Hosts**: Exactly `content.pancake.vn`, `statics.pancake.vn`, or `cdn.pancake.vn`. Wildcards, subdomains such as `pos.pancake.vn`, IP addresses, and any other origin are rejected.
3. **Reviewed Extensions**: Lowercase `.jpg`, `.jpeg`, `.png`, or `.webp` only.
4. **Reviewed Legacy Path Shape**: `/:segment/:id/:id/:id/:file`, where the three ID segments are numeric and the final filename uses a reviewed image extension.
5. **Reviewed Modern Path Shapes**: `/web-media-*` with exactly four or five intermediate path segments before the filename. This corresponds to the two fixed-depth shapes represented in `next.config.mjs`; unbounded `/web-media-*/**` access is not part of the contract.
6. **No User Credentials**: Rejects any URI containing userinfo (`user:pass@`).
7. **Standard Port Only**: Rejects custom ports and explicit default ports in the raw authority.
8. **Path Traversal Protection**: Rejects traversal before WHATWG normalization. Raw `..` forms and percent-encoded dot forms such as `%2e`, `%2e.`, `.%2e`, and `%2e%2e` fail closed instead of being normalized into a different path.
9. **Bounded Length**: Maximum 4,096 characters.
10. **Resolver vs. Remote Image Fetching**: The resolver itself is local and issues no outbound HTTP requests. Storefront rendering through `next/image` may cause the Next.js Image Optimization layer to retrieve approved remote images on demand; those outbound targets are constrained by the exact `images.remotePatterns` host, extension, and fixed-depth path allowlist above, rather than by an unrestricted remote-image proxy.

### Video

Editorial video uses the same HTTPS, authority, traversal, length, and reviewed path-shape rules, but intentionally keeps a narrower trust boundary:

- host: `content.pancake.vn` only;
- extension: lowercase `.mp4` only;
- image-only CDN hosts `statics.pancake.vn` and `cdn.pancake.vn` are not inherited by the video parser or `media-src`.

### Parity Requirements

The trust decision is intentionally duplicated only at boundaries that need an independent enforcement mechanism:

- `parseTrustedProductImageUrl` is the canonical TypeScript image validator;
- the admin product-health SQL predicate must classify the same image URL fixtures the same way;
- Next.js `images.remotePatterns` exposes only the reviewed hosts, extensions, and the fixed legacy / modern path depths;
- CSP `img-src` contains the three reviewed image hosts, while `media-src` keeps only the reviewed video host.

Any change to one of these boundaries must update the parity tests in the same change.

## Deterministic Selection & Deduplication

[`resolveStorefrontProductMedia`](../../src/commerce/product-media.ts) collects and deduplicates images deterministically in stable order:

1. Candidate 1: Product `primaryImageUrl` (if valid and trusted).
2. Candidate 2+: Variation image URLs in sequence.

### Bounds & Protection Against Untrusted External Payloads

- **Candidate Scan Budget (`MAX_MEDIA_CANDIDATES_SCANNED = 100`)**: Bounds the total number of candidate URLs processed across product and variations.
- **Search Read Boundary**: Search suggestions apply the same 100-candidate budget inside the per-product database read, so unbounded variant JSON arrays are not materialized into application memory before the resolver cap is applied.
- **Gallery Output Cap (`MAX_STOREFRONT_GALLERY_IMAGES = 12`)**: Caps the maximum number of unique trusted images returned to 12, preserving deterministic first-N order while bounding DOM nodes, network payload, and downstream rendering costs.

### Deduplication Rules

- If a variation image matches the product primary image, it is not repeated in the gallery.
- If multiple variations reference the same image URL, only the first occurrence is retained.
- Untrusted, malformed, or missing URLs are silently filtered out without failing the entire product view.
- If no images are trusted/present, the resolver safely returns `primary: null, gallery: []`.

### Alt Text Rules

- If only one image is available: `alt = "${productName}"`.
- If multiple gallery images are available: `alt = "${productName} - Ảnh ${index + 1}"` for gallery items, and `alt = "${productName}"` for the primary image.
- Blank/whitespace product names fall back to `"Product"`.

## Verification Evidence

Current verification for this contract on PR #99 includes:

- `tests/domain/product-media.test.ts`: image/video host separation, reviewed extensions and path shapes, raw/encoded traversal rejection (including `%2e`, `%2e.`, and `.%2e`), length/authority checks, deterministic resolution, deduplication, and media bounds.
- `tests/database/admin-product-health-repository.test.ts`: database image-trust predicate parity with the TypeScript parser across valid and invalid legacy/web-media fixtures.
- `tests/domain/storefront-product-media-rendering.test.ts`: parity between parser-approved image shapes and the fixed-depth Next.js `remotePatterns`; the unbounded `/web-media-*/**` shape is explicitly excluded.
- `tests/database/storefront-search-actions.test.ts`: deterministic trusted-image fallback across variants and a database-bound assertion that at most `MAX_MEDIA_CANDIDATES_SCANNED = 100` media candidates are materialized per product.

Verified on head `226bc0bfe7adb1a38e5fc0f32db0181e632cab73` before this documentation-only update:

- Domain tests: **2372 passed / 0 failed**.
- Database smoke tests: **578 passed / 0 failed**.
- ESLint: completed successfully (repository warnings remain non-fatal).
- TypeScript typecheck: completed successfully.
- Next.js production build: completed successfully.
- HTTP security smoke, guest checkout HTTP smoke, production-start smoke, and admin-auth/runtime checks: completed successfully.
- Four accessibility/browser runtime jobs: completed successfully.
- Merchant feed runtime, Catalog indexation runtime, P18 final QA runtime, and VPS container verification: completed successfully.
