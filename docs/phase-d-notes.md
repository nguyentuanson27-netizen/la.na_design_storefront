# Phase D — headless seams: findings and carry-forward

Six route-facing components were split into a headless half (decisions, shared) and a brand half
(markup, discarded per brand), with the existing `src/components/**` module kept as a logic-free
shim so no `src/app` route changed. What follows is what the work turned up, not a summary of it.

## 1. The runner forced a three-file shape, not a design preference

`node --experimental-strip-types --test` cannot load a `.tsx` module, and cannot load anything that
reaches `next/headers` — which every server action in this repo does. A hook that wires up a server
action is therefore untestable here, whatever it is named.

So where a task asked for a hook, the decisions inside it were pulled one level further out into a
pure module:

| Task | pure decisions | wiring | markup |
| --- | --- | --- | --- |
| T13 | `build-product-card-model.ts` | (none needed) | `brand/product-card.tsx` |
| T14 | `variant-selection-model.ts` | `use-variant-selection.ts` | `brand/purchase-panel.tsx` |
| T15 | `resolve-gallery-model.ts` | (state lives in the brand file) | `brand/product-gallery.tsx` |
| T16 | `cart-line-model.ts` | `use-cart-line.ts` | `brand/cart-line-controls.tsx` |
| T17 | `account-auth-model.ts` | `use-account-auth.ts` | `brand/account-auth-panel.tsx` |

The pure modules are what the characterization tests hold. Without them Phase D would have moved
code without testing any of it.

## 2. Behaviour preserved, including two quirks worth revisiting

Both are characterized in tests rather than fixed, because changing either is a product decision and
this phase was a refactor.

**Size change keeps an unavailable colour.** `resolveSelectionAfterSizeChange` clears the selected
colour only when the projection reports that colour `disabled`. A colour that simply does not come
in the newly chosen size stays selected, and the selection then resolves to no variant: the shopper
sees the product-level price again and must choose once more, with no message explaining why. See
`tests/domain/variant-selection-model.test.ts`, "choosing a size clears only a colour the projection
marks disabled". Worth a UX decision in a later phase.

**The cart editor refreshes on refusals but not on thrown calls.** Every answer the server gives —
including `LINE_UNAVAILABLE` — triggers `router.refresh()`; a request that threw does not. That is
defensible (there is no committed state to re-read, and a refresh would discard the shopper's typed
quantity) but it is accidental rather than decided. `tests/domain/cart-line-model.test.ts` pins it.

## 3. G1 carry-forwards

**Done.** `ProductCardModel` carries `primaryImage`, `hoverImage` and `colorSwatches`; the gallery
and the purchase selection now share selection semantics, so a PDP that passes `selectedVariantId`
and `galleryIndexByVariantId` to the brand gallery gets a frame that follows the colour choice. A
thumbnail the shopper clicks is tagged with the variant it was clicked for, so it wins while that
variant is selected and retires when the selection moves.

**Not done, deliberately.** `material`, `craftDetails` and collection editorial storage are Phase E.
Lightbox and sticky add-to-cart are presentation and need no seam.

**Open.** `colorSwatches` resolve to an image only when the caller supplies
`galleryIndexByVariantId`. The PDP has that mapping; listing surfaces do not, so their swatches are
colour-only. Giving listings real swatch images means widening what the listing repository selects —
repository work, and out of scope here.

## 4. Two source-scanning tests had to follow the code

Neither contract changed; both were asserting against a file that no longer holds the thing.

- `storefront-promotion-ui-contract.test.ts` matched
  `resolveStorefrontDiscountPresentation(productLevelOptions)` in the panel's source. That call is
  now in the headless model, so the text match would only have proved where code sits. The contract
  it existed for — an unselected PDP prices from the parent's own options, never from a cheaper
  component — is now asserted behaviourally instead, which is stronger.
- `storefront-language-inventory.test.ts` read the panel's Vietnamese copy from the commerce module.
  It now reads the brand module, and additionally checks the shim carries none of the old English
  copy, so a shim that starts accumulating markup is caught.

A general point for later phases: source-text assertions against a specific path are brittle under
exactly this kind of move. Where the same guarantee can be asserted behaviourally, it should be.

## 5. Checkout was adapted, not split

`brand/guest-checkout-form.tsx` renders the shared form and nothing else. Checkout is one workflow —
a quote proof that must still be valid at submit, an address narrowed province → district → commune
with each level invalidating the ones below, and a server action that is the only authority on
acceptance. Re-drawing it means re-deriving that order, and the failure mode is an order placed
against a stale quote. `tests/domain/brand-checkout-adapter.test.ts` fails if a fork starts: it
asserts exactly one component imports the submit action.

If checkout ever does need a real seam, it wants its own phase and its own characterization tests.

## 6. Environment findings (not code defects)

- `pnpm money:audit` exits 1 without `PANCAKE_SHOP_ID`, even though the script is read-only and
  never calls Pancake. Output before and after Phase D is byte-identical, but the local mirror is
  empty (`ProductMirror` = 0 rows), so this is a weak signal: it proves nothing regressed, not that
  the money paths are exercised.
- The local database is missing the auth tables (`User`, `Session`, `Account`, `Verification`) that
  `prisma/schema.prisma` defines. `tracking.spec.ts` › "account password help satisfies buyer Axe
  contrast" therefore times out on `/account` waiting for `networkidle`. It fails identically on
  `main@507f89a`, checked directly, so it is a missing local migration and not a Phase D regression.
- The Playwright specs pin `@playwright/test` 1.62.0, whose headless shell build (1234) is not the
  Chromium this environment ships (1194). Runs here named `/opt/pw-browsers/chromium` explicitly via
  a local config kept out of the repo, rather than downloading a browser.

## 7. Two seams the route migration will have to look at

Both are fine today — the boundary verifier checks each `src/app` file's own edges, not the graph
below it, and no route changed in this phase — but Phase E moves routes onto these files.

- `brand/product-card.tsx` imports `@/components/analytics/product-select-link`, which is neither
  brand nor headless. It is presentational and a redrawn card would want it, so the likely answer is
  that it moves rather than that the card stops using it.
- `headless/use-cart-line.ts` imports `next/navigation`, which is not in the policy's external
  allowlist (`react`, `react-dom`, `next`, `next/image`, `next/link`). Only `src/app` files are
  checked against that list, so nothing fails now; a route that reaches the router through this hook
  is fine, one that imports `next/navigation` itself is not.
