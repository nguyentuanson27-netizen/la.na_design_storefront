# Phase F — Language tests: the A/B/C classification

Task 33 asked for the classification first, because it decides the real size of the work. This is
that classification, done line by line rather than estimated.

## 1. The count

Spec 07 counted **23 assert statements** across the two files. Today there are **32** — 24 in
`storefront-language-inventory.test.ts` and 8 in `storefront-u1c-final-language.test.ts`. The
difference is not drift: Phases D and E added assertions when copy moved (the purchase panel's copy
to the brand layer, listing titles to `routes/metadata/*`). Every one of those additions is type A.

## 2. The classification

| Type | What it is | Count | Needed changing? |
| --- | --- | --- | --- |
| **A** | Banned English buyer phrases | 20 statements, ~60 strings | No |
| **B** | Banned technical vocabulary | 6 statements, 7 strings | No |
| **C** | Required Vietnamese copy carrying the brand name | 6 statements | Yes |

Spec 07 estimated ~14 A/B, ~6 pattern, ~3 render. The real split is close: 26 A/B statements
untouched, 6 C statements, of which 2 are rendered checks in Playwright.

**A** — `PHRASE_TERMS` (29 strings), `HEADING_TERMS` (8), `EXACT_LABELS` (6), and the inline
`oldCopy` loops on the shop listing, shop loading, collection detail, purchase panel, PDP, cart
loading/error and the whole of the u1c file. Nothing about them is brand-specific.

**B** — `catalog mirror`, `phía máy chủ`, `client`, `Tìm trong catalog`, `catalog cửa hàng`,
`Membership của collection`.

**C** — the six that carry the brand name:

| Where | Form |
| --- | --- |
| `src/app/shop/page.tsx` | `{BRAND.identity.name} / Cửa hàng` |
| `src/app/shop/loading.tsx` | `{BRAND.identity.name} / Cửa hàng` |
| `src/app/collections/[slug]/page.tsx` | `{BRAND.identity.name} / Bộ sưu tập` |
| `src/app/shop/[slug]/page.tsx` | `{BRAND.identity.name} / Sản phẩm` |
| `src/routes/metadata/collections.ts` | `` `…từ ${BRAND.identity.name}.` `` |
| Playwright (PDP, collection landing) | rendered eyebrow text |

## 3. What actually changed, and why it is not a weakening

The required-copy half of C was already pattern-based from earlier phases. The half that was still
broken was the **banned** half.

`"LA Clothing / Store"` is banned on the shop listing. On a fork that renames the brand, that string
can never match again — so the ban silently stops protecting anything, exactly when the redesign
that needs it is happening. The fix derives the same shapes from `BRAND.identity.name`:

```ts
function brandEyebrow(suffix: string, brandName = BRAND.identity.name): string {
  return `${brandName} / ${suffix}`;
}
```

and bans `brandEyebrow("Store")`, `brandEyebrow("Product")`, `brandEyebrow("Collection")`
**alongside** the `LA Clothing / …` literals, which stay. The origin brand's copy must never come
back either. So every A/B set is the same size or larger; none shrank.

Two rendered checks in Playwright had the same problem and got the same fix, reading the brand from
config rather than repeating `"LA Clothing"`.

## 4. The rename proof

The acceptance criterion asks for proof by temporarily changing the brand name. Passing is not the
proof — a rule that stopped checking anything also passes. Both halves were run:

1. `BRAND.identity.name` temporarily set to `Nguyễn Atelier`; both language suites **10/10 pass** —
   no false failure.
2. With that rename still in place, `Nguyễn Atelier / Store` injected into the shop page's eyebrow:
   `U1b shop listing` goes **red**. Before this change that violation passed silently.

Both edits were reverted; neither is committed. The committed
`C rules follow the configured brand name, so a fork inherits them` test keeps the parameterised
half of that proof permanently.

## 5. Left alone deliberately

- `NON_BUYER_PREFIXES` — `src/generated/`, `src/app/admin/`, `tests/a11y-runtime/admin-` — unchanged.
  Admin is not buyer copy and is still excluded.
- The u1c file has no brand coupling at all, so nothing there was converted; it gained only a header
  comment recording that, so the next reader does not re-derive it.
- Playwright fixture data that happens to contain `LA Clothing` (seeded `seoTitle`/`seoDescription`
  values) is test input, not a language assertion, and was not touched.
- Brand literals remain in `editorial.spec.ts` (`LA Clothing — Trang chủ`) and
  `evergreen-pages.spec.ts` (`Về LA Clothing`). Both read from copy owned by `NAVIGATION` and the
  public brand facts rather than page prose, and converting them was outside Task 33's stated scope
  of two Playwright specs. Worth doing when those surfaces are next touched.
