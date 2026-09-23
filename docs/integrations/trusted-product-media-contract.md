# Trusted product-image media contract

Status: **P3 trusted media resolver implemented on branch `build/p3-trusted-product-images`. Ready for review.**

This document defines the storefront media resolution and trust contract introduced in FINAL PLAN V2 Task P3.

## Architectural Boundary

Task P3 establishes a pure, synchronous media resolver ([`src/commerce/product-media.ts`](file:///d:/weblaclothing/src/commerce/product-media.ts)) operating over product-level (`ProductMirror.primaryImageUrl`) and variation-level (`VariantMirror.pancakeImageUrls`) image URIs.

Rendering components (Next.js `next/image`, responsive galleries, CSP headers, and fallback cards) belong to Task P4. Editorial content belongs to Task P5. Slug policy belongs to Task P6.

## Media Trust Policy

Pancake responses are untrusted external inputs. The media resolver enforces strict fail-closed trust rules:

1. **Protocol**: Strictly `https:` (rejects `http:`, `ftp:`, `data:`, `javascript:`, `file:`, etc.).
2. **Reviewed Host**: Exactly `content.pancake.vn` (rejects unreviewed origins, wildcards, subdomains like `pos.pancake.vn`, or IP addresses).
3. **Exact Reviewed Path Shape & Extension**: Path must strictly match `/:segment/:id/:id/:id/:file.(jpg|png|webp)` (exactly 5 path segments after leading `/`: a valid segment name, 3 non-empty numeric ID segments, and a valid filename ending strictly in lowercase `.jpg`, `.png`, or `.webp`). Rejects arbitrary paths, fewer/extra segments, non-numeric ID segments, and unreviewed extensions (`.jpeg`, `.svg`, uppercase `.JPG`/`.PNG`/`.WEBP`, etc.).
4. **No User Credentials**: Rejects any URI containing userinfo (`user:pass@`).
5. **Standard Port Only**: Rejects custom ports (e.g. `:8443`) and explicit default ports in authority.
6. **Path Traversal Protection**: Rejects raw or encoded path traversal tokens (`..`, `%2e%2e`) in the path before or after WHATWG URL normalization.
7. **Bounded Length**: Maximum 4,096 characters.
8. **No Server-Side Image Proxy / Fetcher**: The resolver is a pure in-memory validator and does not issue outbound HTTP requests, eliminating SSRF and open-proxy risks.

## Deterministic Selection & Deduplication

[`resolveStorefrontProductMedia`](file:///d:/weblaclothing/src/commerce/product-media.ts) collects and deduplicates images deterministically in stable order:

1. Candidate 1: Product `primaryImageUrl` (if valid and trusted).
2. Candidate 2+: Variation image URLs in sequence (variant 0 index 0, variant 0 index 1, variant 1 index 0, ...).

### Bounds & Protection Against Untrusted External Payloads:
- **Candidate Scan Budget (`MAX_MEDIA_CANDIDATES_SCANNED = 100`)**: Bounds the total number of candidate URLs processed across product and variations, preventing CPU/memory exhaustion attacks from unbounded upstream arrays.
- **Gallery Output Cap (`MAX_STOREFRONT_GALLERY_IMAGES = 12`)**: Caps the maximum number of unique trusted images returned to 12, preserving deterministic first-N order while bounding DOM nodes, network payload, and downstream rendering costs.

### Deduplication Rules:
- If a variation image matches the product primary image, it is not repeated in the gallery.
- If multiple variations reference the same image URL, only the first occurrence is retained.
- Untrusted, malformed, or missing URLs are silently filtered out without failing the entire product view.
- If no images are trusted/present, the resolver safely returns `primary: null, gallery: []`.

### Alt Text Rules:
- If only one image is available: `alt = "${productName}"`.
- If multiple gallery images are available: `alt = "${productName} - Ảnh ${index + 1}"` for gallery items, and `alt = "${productName}"` for the primary image.
- Blank/whitespace product names fall back to `"Product"`.

## Verification Evidence

### Pre-Implementation RED Evidence

1. **Initial Module Resolution Failure**:
   ```
   Error [ERR_MODULE_NOT_FOUND]: Cannot find module 'D:\weblaclothing\src\commerce\product-media.ts' imported from D:\weblaclothing\tests\domain\product-media.test.ts
   ✖ tests\domain\product-media.test.ts (147.4081ms)
   ```

2. **Unreviewed Path Shape Rejection Failure**:
   ```
   ✖ parseTrustedProductImageUrl rejects unreviewed path shapes on trusted host (2.8284ms)
   AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
   + actual - expected
   + 'https://content.pancake.vn/arbitrary/shirt.jpg'
   - null
   ```

3. **Unreviewed Extension Rejection Failure (`.jpeg`, `.png`, `.webp`)**:
   ```
   ✖ parseTrustedProductImageUrl rejects unreviewed file extensions (.jpeg, .png, .webp, .svg, etc.) (1.1338ms)
   AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
   + actual - expected
   + 'https://content.pancake.vn/images/1/2/3/shirt.jpeg'
   - null
   ```

4. **Gallery Cardinality Cap & Candidate Scan Bound Failure**:
   ```
   ✖ resolveStorefrontProductMedia caps returned gallery images at MAX_STOREFRONT_GALLERY_IMAGES (12) (1.0565ms)
   AssertionError [ERR_ASSERTION]: Expected values to be strictly equal: 26 !== 12

   ✖ resolveStorefrontProductMedia bounds candidate scan processing at MAX_MEDIA_CANDIDATES_SCANNED (100) (1.0395ms)
   AssertionError [ERR_ASSERTION]: Expected values to be strictly equal: actual: { url: '...', alt: '...' }, expected: null
   ```

### Post-Implementation GREEN Evidence

- `tests/domain/product-media.test.ts`: Passes all 17 unit tests covering HTTPS allowlisting, exact path shape matching, strict `.jpg` extension filtering, candidate scan bounds, gallery cardinality caps, host/credential/port rejections, path traversal, boundary sizing, deterministic resolution, and deduplication.
- Full repository test runner: 295 passed / 0 failed.
- TypeScript (`tsc --noEmit`): 0 errors.
- ESLint (`eslint .`): 0 errors.
- Next.js Production Build (`next build`): 18/18 static and dynamic routes compiled successfully.


